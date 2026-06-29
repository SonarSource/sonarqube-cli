# Engineering Plan: Onboarding at Scale via CLI (MMF-5732)

## Context

Enterprise admins must click through the web UI hundreds of times to onboard repositories. This MMF delivers a `sonar import` command that orchestrates existing backend endpoints to import repos from GitHub, GitLab, Azure DevOps, and Bitbucket — both interactively (human-driven wizard) and non-interactively (flags-driven, agent-safe). All required backend APIs are assumed to exist; this plan is exclusively about CLI orchestration, UX, batching, resilience, and test strategy. Ships in three delivery steps: single repo → multi-repo → multi-org.

---

## 1. Assumptions

- All required backend endpoints exist: list DevOps platform configs, list repos per platform config, trigger import (sync or async), poll async job status.
- The `dop-translation` API already used in `client.ts` (`/api/v2/dop-translation/project-bindings`) is the right API family.
- Auth is **not headless** today: the `auth login` flow redirects the user to a browser for token exchange. `sonar import` requires an already-authenticated session.
- CI scan auto-trigger is owned by CI Experience Squad and is **decoupled** from import — import ships first, scan-trigger integrated later.
- `p-limit` or an equivalent concurrency primitive is available (Bun has `Promise.all`; confirm `p-limit` in `package.json` before using it, otherwise implement a semaphore inline matching existing codebase style).
- SonarQube Server compatibility is assumed to work through existing backend compatibility — CLI does not special-case it beyond `connection_type` in telemetry.

---

## 2. Target CLI Architecture / Execution Model

### Command shape

```
sonar import <provider>  [flags]

Providers: github | gitlab | azure | bitbucket

Flags (all providers):
  --devops-platform-key <key>   DevOps platform config key registered in SonarQube
  --org <key>                   SonarQube organization key (Cloud only)
  --repo <repo>                 Single repo slug (Step 1)
  --repos <r1,r2,...>           Comma-separated repo slugs (Step 2+)
  --orgs <o1,o2,...>            Comma-separated DevOps org/namespace keys (Step 3)
  --non-interactive             Skip all prompts; require explicit flags
  --output <format>             text | json  (default: text)
  --concurrency <n>             Parallel imports (default: 5, Step 2+)
  --dry-run                     Resolve repos but make no import API calls
  --resume <path>               Resume from a prior checkpoint file (Step 3)
```

Registered in `src/cli/command-tree.ts` under `rootHelp({ category: 'data' })`. Each provider command uses `authenticatedAction()`.

### Execution model (shared across all steps)

```
authenticatedAction
  └─ resolveDevOpsPlatformKey()    [--devops-platform-key or selectPrompt]
  └─ resolveOrg()                  [--org or selectPrompt from listUserOrganizations]
  └─ resolveRepos()                [--repo/--repos or multiSelectPrompt; Step 3: per org]
  └─ loadCheckpoint()              [--resume flag; Step 3 only]
  └─ runImportBatch(repos, opts)
       └─ per repo: importWithRetry()  [retry on 429/503, up to 3x]
       └─ ImportProgress.update()
  └─ emitImportTelemetry()
  └─ renderBatchSummary() or renderJsonOutput()
  └─ exit: 0 (all ok) | 1 (all failed) | 3 (partial)
```

Interactive vs. non-interactive: **same code path**, different input surface. Each prompt site checks `options.nonInteractive` before calling a prompt primitive, falling back to the provided flag value or throwing `InvalidOptionError` if the flag is absent.

### Exit codes

| Outcome | Code |
|---|---|
| All repos imported successfully | 0 |
| Command/option error | 1 / 2 |
| Partial success (some ok, some failed) | **3** (new — `ImportPartialError extends CliError` with `exitCode = 3`) |
| All repos failed | 1 |

---

## 3. Step 1 Technical Scope — Single org, single repo

**Goal:** smallest production-safe slice. One import, one repo, behind a feature flag if needed.

### New files

```
src/cli/commands/import/
  index.ts                     re-exports providers
  _common/
    types.ts                   ImportOptions, RepoToImport, ImportResult, ImportProvider
    resolve-options.ts         resolveDevOpsPlatformKey(), resolveOrg(), resolveRepo()
    import-client.ts           listDevOpsPlatformConfigs(), listRepositories(), importRepository()
    import-output.ts           renderBatchSummary(), renderJsonOutput()
    error.ts                   ImportPartialError (exitCode: 3)
  github.ts                    handler for sonar import github
  gitlab.ts
  azure.ts
  bitbucket.ts

src/telemetry/import.ts        emitImportTelemetry(), StoredImportEvent, ImportExecutionEventPayload
```

### `resolve-options.ts` pattern

```typescript
export async function resolveDevOpsPlatformKey(
  client: ImportClient,
  opts: { platformKey?: string; nonInteractive?: boolean; provider: ImportProvider },
): Promise<string> {
  if (opts.platformKey) return opts.platformKey;
  if (opts.nonInteractive) throw new InvalidOptionError('--devops-platform-key is required in non-interactive mode');
  const configs = await withSpinner('Loading platform configs...', () => client.listDevOpsPlatformConfigs(opts.provider));
  return selectPrompt('Select DevOps platform configuration', configs.map(...)) ?? throwCancelled();
}
```

Same pattern for `resolveOrg()` (reuses `client.listUserOrganizations()` from existing `client.ts`) and `resolveRepo()`.

### Interactive UI flow (Step 1)

```
intro('Import repository', 'SonarQube')
[resolveDevOpsPlatformKey → resolveOrg → resolveRepo]
withSpinner('Importing <repo>...', doImport)
phase('Import complete', [phaseItem(repo, 'success', projectKey)])
outro('Repository imported successfully', 'success')
```

### Telemetry (`src/telemetry/import.ts`)

New event type `Analytics.Cli.CliImportExecuted` stored in `import-events.ndjson`. Payload:

```typescript
interface ImportExecutionEventPayload {
  // standard fields: cli_installation_id, machine_id, cli_version, invocation_id, os,
  //                  connection_type, user_uuid, organization_uuid_v4, sqs_installation_id, caller_agent
  provider: 'github' | 'gitlab' | 'azure' | 'bitbucket';
  repos_requested: number;
  repos_succeeded: number;
  repos_failed: number;
  concurrency: number;
  used_checkpoint: boolean;
  non_interactive: boolean;
}
```

Hook `flushImportEvents()` into the existing `flushTelemetry` function alongside `flushFindings`.

---

## 4. Step 2 Technical Scope — Single org, multiple repos (parallel)

**Adds:** multi-select, concurrent import, live progress, partial-failure handling.

### New files

```
src/cli/commands/import/_common/
  import-batch.ts      runImportBatch(), importWithRetry(), BatchResult
  import-progress.ts   ImportProgress class (live per-repo status table)
```

### `import-batch.ts`

```typescript
export async function runImportBatch(
  repos: RepoToImport[],
  opts: { concurrency: number; retryBaseDelayMs: number },
  onProgress: (slug: string, status: RepoStatus) => void,
): Promise<BatchResult>
```

Uses a semaphore (or `p-limit`) for `opts.concurrency` in-flight requests. Each repo goes through `importWithRetry()`: up to 3 attempts with exponential backoff, retrying only on `RateLimitError` and `ServiceUnavailableError` (from existing `src/sonarqube/errors.ts`). Non-retriable errors fail immediately. Retry base delay via `ENV_IMPORT_RETRY_BASE_DELAY_MS` constant in `src/lib/config-constants.ts` (same pattern as `ENV_SQAA_RETRY_BASE_DELAY_MS` — makes integration tests deterministic).

### `ImportProgress` class

Modeled on `SqaaProgress` in `src/ui/sqaa-progress.ts`. Single updating status line in TTY. Methods: `start()`, `update(slug, status)`, `finish()`. Status values: `'pending' | 'importing' | 'success' | 'failed'`. On `finish()`, renders a final `phase()` block with per-repo `phaseItem` entries.

### Partial failure

After batch completes:
- All succeeded → exit 0
- All failed → `throw new CommandFailedError(...)` → exit 1
- Mixed → `throw new ImportPartialError(summary)` → exit 3

`--output json` shape:

```json
{
  "provider": "github",
  "total": 10,
  "succeeded": 8,
  "failed": 2,
  "repos": [
    { "repo": "owner/a", "status": "success", "projectKey": "owner_a" },
    { "repo": "owner/b", "status": "failed", "error": "rate limit after 3 retries" }
  ]
}
```

---

## 5. Step 3 Technical Scope — Multiple orgs, multiple repos (bulk scale)

**Adds:** multi-org iteration, checkpoint write/resume.

### New file

```
src/cli/commands/import/_common/checkpoint.ts
```

### `CheckpointState` type

```typescript
interface CheckpointState {
  version: 1;
  provider: ImportProvider;
  startedAt: string;        // ISO timestamp
  completedRepos: string[]; // slugs that succeeded
  failedRepos: Array<{ slug: string; error: string }>;
  pendingRepos: string[];
}
```

### Write strategy

After each `concurrency`-wide wave: `writeCheckpoint(path, state)` — write to `<path>.tmp`, then atomic `renameSync`. Same pattern as `flushFindings` drain in `src/telemetry/findings.ts`.

### Resume strategy

```typescript
const checkpoint = loadCheckpoint(opts.resume);
// Validate provider matches; throw InvalidOptionError if not
const alreadyDone = new Set(checkpoint.completedRepos);
const reposToRun = allRepos.filter(r => !alreadyDone.has(r.slug));
```

`--resume` with non-existent file → `InvalidOptionError`. Provider mismatch → `InvalidOptionError` with remediation hint.

### Multi-org resolution

`resolveOrgs()` mirrors `resolveRepos()`: `--orgs` flag (non-interactive) or `multiSelectPrompt` (interactive). For each org, call `resolveReposForOrg()` to fetch repo list, then flatten into the single batch.

---

## 6. Cross-Cutting Concerns

### Retries
- Retriable: `RateLimitError` (429), `ServiceUnavailableError` (503)
- Max 3 retries per repo; backoff: `baseDelay * 2^attempt`
- Retry base delay overridable via `ENV_IMPORT_RETRY_BASE_DELAY_MS` (makes integration tests deterministic)
- Non-retriable: 400, 401, 403, 404, unknown 5xx after attempt 3

### Rate limiting
- `--concurrency` (default 5) bounds simultaneous in-flight requests
- 429 responses back off and retry the failed repo; other in-flight repos continue uninterrupted

### Progress reporting
- **TTY interactive**: `ImportProgress` live status line + final `phase()` summary block
- **Non-TTY / CI**: plain `info()` lines per repo completion (no live updates)
- **`--output json`**: all progress to stderr, final JSON summary to stdout

### Machine-readable output
- `--output json` writes to stdout; all human messages go to stderr
- Exit codes are stable: scripts/agents can key on exit 3 = partial success

### Async job polling (if backend is async)
- `pollImportJob(client, taskId, { pollIntervalMs, maxAttempts })` in `import-client.ts`
- Default: 2s interval, 30 attempts (1 minute max)
- Override via `ENV_IMPORT_POLL_INTERVAL_MS`

### Telemetry
- `Analytics.Cli.CliCommandExecuted` fires for free via the existing `SonarCommand` post-action hook
- `Analytics.Cli.CliImportExecuted` fires once per handler at end of run with counts: `repos_requested`, `repos_succeeded`, `repos_failed`, `concurrency`, `non_interactive`, `used_checkpoint`

---

## 7. Risks / Tradeoffs

| Risk | Mitigation |
|---|---|
| Backend async vs sync contract unknown | `import-client.ts` handles both: if response has `taskId`, poll; if it has `projectKey` directly, return immediately. |
| `p-limit` not in dependencies | Implement inline semaphore (10 lines) rather than adding a dep — keep footprint minimal. |
| `multiSelectPrompt` caps at 20 visible items | For large portfolios, add `--query` filter flag to pre-filter repos server-side before multi-select. |
| Checkpoint file corruption | `loadCheckpoint` validates schema; on parse failure, throw `InvalidOptionError` with a clear message to delete and restart. |
| CI Experience Squad delays | Import and scan-trigger are fully decoupled. Import ships when ready; scan-trigger can be added to `ImportRepoResult` as an optional field later. |
| Web UI / CLI orchestration divergence | CLI calls same backend endpoints as Web UI. No business logic embedded in CLI. |
| Auth not headless | `sonar import` requires prior `sonar auth login` (browser redirect). Do not describe this flow as "fully headless". |

---

## 8. Recommended Implementation Order

1. `import-client.ts` — API surface first; validates endpoint contracts, unblocks everything else
2. `types.ts` + `error.ts` — shared types, `ImportPartialError`
3. `resolve-options.ts` — interactive + non-interactive resolution logic
4. Step 1 provider handlers (`github.ts` etc.) — single-repo end-to-end, with `--dry-run` and `--output json`
5. Telemetry (`src/telemetry/import.ts`) — emit after Step 1 handlers work
6. Integration tests for Step 1 — fake server builder additions for devops-platform endpoints
7. `import-batch.ts` + `import-progress.ts` — Step 2 concurrency engine
8. Step 2 provider handler updates — multi-select, `--repos`, `--concurrency`
9. Integration tests for Step 2 — batch, partial failure, retry
10. `checkpoint.ts` — write/load/validate
11. Step 3 handler updates — multi-org, `--orgs`, `--resume`
12. Integration tests for Step 3 — checkpoint, resume, multi-org

---

## 9. Jira Breakdown

### Epic 1 — `sonar import` Step 1 (single repo)

- **S1** Command scaffolding: directory structure, `command-tree.ts` registration, `rootHelp`, `ImportPartialError`
- **S2** `import-client.ts`: `listDevOpsPlatformConfigs`, `listRepositories`, `importRepository`, `pollImportJob`
- **S3** `resolve-options.ts`: `resolveDevOpsPlatformKey`, `resolveOrg`, `resolveRepo` — interactive + non-interactive guards
- **S4** Step 1 provider handlers: interactive UI flow, `--dry-run`, `--output json`, Step 1 complete
- **S5** Telemetry: `StoredImportEvent`, `emitImportTelemetry`, `flushImportEvents` wired into flush path
- **S6** Integration tests: fake server builder additions, 8 test cases per provider

### Epic 2 — Step 2 (multi-repo, parallel)

- **S1** `import-batch.ts`: `runImportBatch`, `importWithRetry`, semaphore, `ENV_IMPORT_RETRY_BASE_DELAY_MS`
- **S2** `import-progress.ts`: `ImportProgress` class, live status, `finish()` renders `phase()` summary
- **S3** `resolve-options.ts` extension: `resolveRepos()` for multi-select / `--repos` parsing
- **S4** Provider handler updates: `--repos`, `--concurrency`, partial-failure exit code
- **S5** Integration tests: batch, partial failure, retry, concurrency limit

### Epic 3 — Step 3 (multi-org, checkpoint/resume)

- **S1** `checkpoint.ts`: `writeCheckpoint` (atomic), `loadCheckpoint`, validation
- **S2** `resolveOrgs()`: multi-select / `--orgs` flag; fan-out `resolveReposForOrg()`
- **S3** Batch runner checkpoint integration: `onWaveComplete` callback, `--resume` filter
- **S4** Integration tests: checkpoint write, resume skip, provider mismatch error, multi-org

---

## Critical Files (for implementers)

| File | Role |
|---|---|
| `src/cli/command-tree.ts` | Register new `import` command group |
| `src/cli/commands/_common/sonar-command.ts` | `authenticatedAction()` base; `rootHelp` API |
| `src/sonarqube/client.ts` | Reference for `ImportClient` patterns |
| `src/ui/sqaa-progress.ts` | Pattern for `ImportProgress` |
| `src/ui/components/prompts.ts` | `multiSelectPrompt`, `selectPrompt`, `confirmPrompt` |
| `src/telemetry/findings.ts` | Pattern for `import-events.ndjson` flush |
| `src/lib/config-constants.ts` | Add `ENV_IMPORT_RETRY_BASE_DELAY_MS`, `ENV_IMPORT_POLL_INTERVAL_MS` |
| `src/cli/commands/_common/error.ts` | Add `ImportPartialError` (exitCode 3) |
| `tests/integration/harness/fake-sonarqube-server.ts` | Add devops-platform builder methods |

---

## Verification

- `bun run typecheck` — no TS errors
- `bun run lint` — no lint issues
- `bun run test:unit` — unit tests for `import-batch.ts`, `resolve-options.ts`, `checkpoint.ts`
- `bun run pretest:integration && bun test tests/integration/specs/import/` — full integration tests
- Manual: `sonar import github --non-interactive --devops-platform-key <key> --org <org> --repo <repo> --output json` → exit 0, valid JSON
- Manual (partial fail): force one repo to fail → exit 3, `failed` count > 0 in JSON
- Manual (resume): interrupt mid-batch, re-run with `--resume <checkpoint>` → only pending repos run
