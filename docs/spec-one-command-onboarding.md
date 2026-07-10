# Specification: One-Command Onboarding

**Status:** Draft (runtime-resolution model)  
**Date:** 2026-07-08  
**Authors:** SQ CLI team (UX / integrate)  
**Related:** [SQ CLI UX Improvement Report](./sq-cli-ux-improvement-report.html)

---

## 1. Summary

Introduce **`sonar onboard`** — a single machine-wide command that wires SonarQube into all detected AI agents. After onboard, **every repository benefits automatically** when the agent or CLI runs in that workspace — no per-repo command, no per-repo config files, no "was this repo integrated?" mental model.

The design separates:

| Layer | When | What |
|-------|------|------|
| **Machine onboard** | Once per developer machine | Global MCP, global secrets hooks, global SQAA protocol, global CAG skill, machine profile |
| **Runtime resolution** | Every hook / analyze / MCP / context invocation | Resolve project key + entitlement from `cwd`; fast no-op when repo has no Sonar config |

Users run **one command ever** for setup. Opening any Sonar-linked repo and using the agent just works — the CLI discovers the project at runtime from `sonar-project.properties`, `.sonarlint/`, or git-remote binding.

**Key principle:** install once at machine scope; resolve per-repo context at runtime. No per-repo file writes for agent features.

---

## 2. Goals

### 2.1 Primary goals

- **G1:** One command (`sonar onboard`) completes machine setup with zero agent-specific subcommands.
- **G2:** Any repo with discoverable Sonar config is fully usable (secrets, SQAA, CAG, MCP) without a second CLI command or per-repo artifacts.
- **G3:** Users do not need to understand global vs project scope, MCP, hooks, or feature IDs to get value.
- **G4:** Onboard is **idempotent** and safe to re-run; upgrades repair drift via `sonar doctor --fix`.

### 2.2 Non-goals (v1)

- Auto-installing git pre-commit/pre-push hooks without explicit opt-in.
- Scanning the entire filesystem for all git repos at onboard time.
- Replacing per-agent subcommands (`sonar integrate cursor`, etc.) — they remain for power users and support.
- Writing per-repo agent config files (`.cursor/rules/`, `.agents/skills/`, project hooks) as part of onboard or background bind.

---

## 3. User experience

### 3.1 Golden path

```bash
sonar auth login
sonar onboard
# Restart AI tool(s) once
```

User opens any repo with `sonar-project.properties`, `.sonarlint/connectedMode.json`, or git-remote project binding → starts using Cursor/Claude → secrets, MCP, SQAA, and CAG work immediately. No CLI command in that repo. No Sonar files written into the repo by onboard.

Verify:

```bash
sonar projects list
sonar doctor
```

### 3.2 What the user sees during `sonar onboard`

```
SonarQube Onboarding

Connection
  ✓ SonarQube Cloud — my-org
  ✓ Token active

Agents detected
  ✓ Cursor
  ✓ Claude Code
  ○ Codex (not installed — skipped)

This will:
  • Block secrets in prompts and file reads (all projects)
  • Run AI code review at end of agent turns (Sonar-linked repos)
  • Expose SonarQube issues and quality gates via MCP
  • Work in any Sonar-linked repo automatically — no per-repo setup

Press Enter to continue...

Installed
  ✓ Cursor — global MCP, global secrets hooks, global SQAA protocol
  ✓ Claude Code — global MCP, global secrets hooks, global SQAA hooks
  ...

Setup complete!

Next steps:
  1. Restart Cursor and Claude Code
  2. Open a Sonar-linked project and ask your agent about open issues
  3. Run: sonar projects list
```

No per-feature Y/N prompts in default mode. One preview box, one confirm (skipped with `--yes`).

### 3.3 What the user does *not* see in a new repo

When opening repo #50 and sending the first prompt:

- No modal, no CLI command, no files written into the repo.
- Secrets scan runs via global hooks (already installed).
- SQAA / MCP / CAG resolve the project key from repo config at runtime.
- Optional single info line on first successful resolution (configurable, default off):
  `Sonar: linked repo my-org:api-gateway`
- Debug log when `SONAR_LOG_LEVEL=debug`.

If the repo has **no** Sonar config: silent no-op for Sonar-specific features; secrets still work; agent is unaffected.

---

## 4. Architecture

### 4.1 Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  sonar onboard (once)                                             │
│  • detect installed agents                                        │
│  • resolve entitlements (SQAA, CAG) — cache on machine profile    │
│  • install GLOBAL integrations per agent (non-interactive)        │
│  • persist MachineOnboardProfile in state                         │
│  • NO per-repo file writes                                        │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│  Every agent / CLI invocation in a workspace                      │
│  → resolveRuntimeProjectContext(cwd)                              │
│     1. resolve git root / canonical project root                  │
│     2. skip if no auth                                            │
│     3. check negative cache — no Sonar config here? fast no-op    │
│     4. discoverProject(root) — no key? cache negative, return     │
│     5. check entitlement cache (SQAA / CAG per org)               │
│     6. return { projectKey, orgKey, entitlements, root }          │
│     7. hook / analyze / MCP / context proceeds with context     │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 Machine onboard vs runtime resolution

| Artifact | Machine onboard (global) | Runtime resolution |
|----------|--------------------------|-------------------|
| `~/.cursor/mcp.json` → `sonar run mcp` | ✓ | MCP discovers project from `cwd` at spawn |
| `~/.cursor/hooks.json` secrets | ✓ | Secrets scan (no project key needed) |
| `~/.claude.json` / global hooks | ✓ | |
| Global SQAA hooks (Claude PostToolUse, Codex PostToolUse) | ✓ | Handler calls `resolveRuntimeProjectContext(cwd)` |
| Global SQAA instructions (Copilot, Antigravity) | ✓ | Template uses `sonar analyze agentic --depth DEEP` (no baked key) |
| Global CAG skill (`~/.agents/skills/.../SKILL.md` or agent-specific global path) | ✓ | Passthrough resolves project at runtime; daemon bootstrapped on first use |
| `.cursor/rules/sonar-agentic-analysis.mdc` | ✗ (see §9.1) | Delivered via MCP or global rule fallback |
| `.cursor/hooks.json` (project) | ✗ | Global hooks only |
| `.agents/skills/.../SKILL.md` (project) | ✗ | Global skill only |
| Git pre-commit hook | ✗ (opt-in only) | |
| `integrations.installed` state (global features) | ✓ | |
| Per-repo `integrations.installed` entries | ✗ | Not required for onboard UX |

### 4.3 Runtime resolution call sites

Every project-bound code path calls the same resolver:

| Trigger | When it fires | What it resolves |
|---------|---------------|------------------|
| **SQAA hook handlers** (`agent-post-tool-use`, `codex-post-tool-use`) | After each edit / patch | Project key + SQAA entitlement |
| **`sonar analyze agentic`** | Explicit or agent-invoked analysis | Project key (default when `--project` omitted) |
| **`sonar run mcp` startup** | MCP session init | Project key for scoped tools |
| **`sonar context` passthrough** | CAG invocation | Project key + org + CAG attrs |
| **Global secrets hooks** | Prompt / file read | No project resolution (repo-agnostic) |

Performance requirements:

- **Negative cache** for repos with no Sonar config: p95 &lt;10ms (no API calls).
- **Positive cache** (project key + entitlement per git root): p95 &lt;50ms when cache warm.
- **Cold path** (first visit to a Sonar-linked repo): p95 &lt;500ms excluding CAG binary download.
- Secrets scan must never be blocked waiting for project resolution.

### 4.4 MCP and cwd

Global MCP config:

```json
{
  "mcpServers": {
    "sonarqube": {
      "command": "/path/to/sonar",
      "args": ["run", "mcp"]
    }
  }
}
```

No `--project` baked in. `runMcp` calls `resolveRuntimeProjectContext(cwd)` (which wraps `discoverProject(cwd)`) at spawn time.

---

## 5. Command surface

### 5.1 `sonar onboard`

```
sonar onboard [options]
```

| Option | Description |
|--------|-------------|
| `--yes`, `-y` | Skip confirmation preview |
| `--non-interactive` | Alias for CI: implies `--yes`, no TTY prompts |
| `--agents <list>` | Comma-separated subset: `cursor,claude,codex,copilot,antigravity` |
| `--minimal` | MCP + secrets only; skip SQAA/CAG global setup |
| `--with-git` | Also set `machine.gitHooks=opt-in` hint (does not install hooks globally) |
| `--skip-context` | Skip CAG entitlement check and global CAG skill install |

**Requires:** authenticated session (`sonar auth login`).

**Does not accept:** `--project`, `--global` (scope is implicit: machine-wide).

### 5.2 `sonar projects list` (new)

```
sonar projects list [options]
```

| Option | Description |
|--------|-------------|
| `--json` | Machine-readable output |
| `--scan <path>` | Report Sonar-configured repos under path (from config files / git remotes) |

Output columns: `root`, `projectKey`, `lastResolvedAt`, `source` (properties / sonarlint / git-remote / state), `status` (configured / resolved / stale).

Note: under the runtime model, "bound" means "Sonar config discoverable" or "recently resolved at runtime" — not "per-repo integrate ran".

### 5.3 `sonar doctor` (extend existing `system status` or new command)

```
sonar doctor [--fix] [--json] [integrations]
```

Per-agent MCP/hook freshness, stale `sonar` binary paths, missing global markers, entitlement cache age. `--fix` re-applies machine profile global artifacts.

### 5.4 Deprecated path (unchanged, not removed)

- `sonar integrate` (bare router) — remains; help text points to `sonar onboard`.
- `sonar integrate <agent>` — remains for targeted repair and legacy per-repo installs.

---

## 6. Machine profile (state)

New section in `CliState` (or separate `~/.sonar/sonarqube-cli/onboard-profile.json`):

```typescript
interface MachineOnboardProfile {
  onboardedAt: string;           // ISO timestamp
  onboardedByCliVersion: string;
  agents: AgentOnboardEntry[];   // cursor, claude, ...
  entitlements: {
    sqaa: 'enabled' | 'not_enabled' | 'check_failed' | 'unknown';
    cag: 'allowed' | 'not_allowed' | 'check_failed' | 'unknown';
    sca: boolean;
    checkedAt: string;
  };
  preset: 'recommended' | 'minimal';
}

interface AgentOnboardEntry {
  agentId: string;
  globalFeaturesInstalled: string[];
}
```

Entitlement cache TTL: **24 hours** — refresh on `sonar doctor --fix` or `sonar onboard` re-run.

Runtime resolution cache (separate file `~/.sonar/sonarqube-cli/runtime-project-cache.json`):

```typescript
interface RuntimeProjectCacheEntry {
  gitRoot: string;               // canonical git root (hashed key in storage)
  projectKey?: string;           // absent = negative cache
  orgKey?: string;
  source: 'properties' | 'sonarlint' | 'git-remote' | 'state';
  resolvedAt: string;
  expiresAt: string;             // TTL: 1h positive, 24h negative
}
```

---

## 7. Runtime resolution: `resolveRuntimeProjectContext`

### 7.1 Module

**Path:** `src/lib/runtime-project-context.ts`

```typescript
export interface ResolveRuntimeProjectContextOptions {
  cwd?: string;
  auth?: ResolvedAuth;
  requireSqaa?: boolean;
  requireCag?: boolean;
}

export async function resolveRuntimeProjectContext(
  options: ResolveRuntimeProjectContextOptions,
): Promise<RuntimeProjectContext | null>;

interface RuntimeProjectContext {
  projectRoot: string;
  projectKey: string;
  orgKey?: string;
  serverUrl: string;
  sqaaEnabled: boolean;
  cagEnabled: boolean;
  source: 'properties' | 'sonarlint' | 'git-remote' | 'state';
}

interface RuntimeProjectContextResult {
  status:
    | 'resolved'
    | 'skipped_no_config'
    | 'skipped_no_auth'
    | 'skipped_not_entitled'
    | 'cached_negative';
  context?: RuntimeProjectContext;
}
```

### 7.2 Algorithm

1. Resolve `auth` (from options or `resolveAuth()`); if missing, return `skipped_no_auth`.
2. Canonical git root via `findGitRoot(cwd)`; if not git, use `cwd`.
3. Check runtime cache for `gitRoot`:
   - Negative entry (no project key, not expired) → `cached_negative` (fast no-op).
   - Positive entry (not expired) → return cached context (refresh entitlement if stale).
4. `discoverProject(root, true, { auth })`:
   - No `projectKey` → write negative cache, return `skipped_no_config`.
5. Fallback: `resolveSqaaProjectKey(root)` from integration state (legacy per-repo installs).
6. Resolve entitlements from machine profile cache (refresh if &gt;24h):
   - SQAA: `hasSqaaEntitlement(orgKey)` when `requireSqaa`.
   - CAG: org + Cloud check when `requireCag`.
7. Write positive cache entry; return `resolved`.

### 7.3 Call sites (v1)

| File | Insertion point |
|------|-----------------|
| `src/cli/commands/hook/agent-post-tool-use.ts` | Replace hard `--project` requirement; resolve from `process.cwd()` |
| `src/cli/commands/hook/codex-post-tool-use.ts` | Same |
| `src/cli/commands/analyze/sqaa-auth.ts` | Discovery-first project key resolution |
| `src/cli/commands/analyze/sqaa.ts` | Default `--project` from resolver when omitted |
| `src/cli/commands/run/mcp.ts` | Before container spawn |
| `src/cli/commands/context/index.ts` | Replace state-only lookup with discovery-first |

Hook handlers must use **workspace root** (`process.cwd()` or stdin workspace path), not hook script directory.

---

## 8. Project-agnostic global delivery

Today SQAA and CAG bake the project key at install time. Under the runtime model, all global artifacts are project-agnostic.

### 8.1 Project key resolution order

Central resolution for all commands:

```
projectKey =
  explicit --project
  ?? discoverProject(cwd).projectKey
  ?? resolveSqaaProjectKey(cwd)   // legacy state fallback
```

Apply to SQAA hook handlers, `sonar analyze agentic`, CAG passthrough, and MCP scoped tools.

### 8.2 Global SQAA hooks (Claude, Codex)

**Before (per-repo integrate):**

```bash
sonar hook claude-post-tool-use --project my-org:my-key
```

**After (machine onboard):**

```bash
sonar hook claude-post-tool-use
```

Installed globally in `~/.claude/settings.json` / `~/.codex/hooks.json`. Handler resolves project at runtime; no-ops fast when repo has no Sonar config.

Claude also gets global SQAA end-of-turn instructions in `~/.claude/CLAUDE.md` (or agent-equivalent global instructions path) using the project-agnostic template.

### 8.3 Global SQAA instructions (Copilot, Antigravity, Cursor fallback)

**Before:**

```bash
sonar analyze agentic --project my-key --depth DEEP
```

**After:**

```bash
sonar analyze agentic --depth DEEP
```

Written to:

- Copilot: `~/.copilot/instructions/sonarqube.instructions.md`
- Antigravity: global rules snippet in `~/.gemini/GEMINI.md` + `~/.agents/rules/sonar-agentic-analysis.md` (global path)
- Cursor (fallback): see §9.1

CLI discovers project key from repo config when the agent runs the command.

### 8.4 Global CAG skill + lazy daemon bootstrap

At machine onboard (when entitled):

- Install CAG binary (shared dependency).
- Write skill to global skills dir:
  - Claude: `~/.claude/skills/sonar-context-augmentation/SKILL.md`
  - Codex/Cursor/Antigravity: `~/.agents/skills/sonar-context-augmentation/SKILL.md`
  - Copilot: `~/.github/skills/sonar-context-augmentation/SKILL.md` (under homedir)

At runtime (`sonar context` passthrough):

1. `resolveRuntimeProjectContext(cwd)` → project key + org.
2. If CAG daemon not running for this project root, bootstrap silently (first call only).
3. Forward env vars (`SONAR_CONTEXT_PROJECT`, etc.) as today.

No per-repo skill file. Daemon bootstrap is the only inherently per-repo side effect — invisible to the user.

### 8.5 Global secrets + MCP (unchanged)

Already supported at global scope. No project key required for secrets. MCP resolves project at spawn via runtime resolver.

---

## 9. Agent-specific notes

### 9.1 Cursor

| Concern | Approach |
|---------|----------|
| Global MCP | `~/.cursor/mcp.json` at machine onboard |
| Global secrets hooks | `~/.cursor/hooks.json` at machine onboard |
| SQAA | **Gap:** Cursor has no CLI-writable global always-apply rule; `afterFileEdit` hook is fire-and-forget (no `additionalContext`). See options below. |
| CAG | Global skill at `~/.agents/skills/sonar-context-augmentation/SKILL.md`; runtime daemon bootstrap |

**Cursor SQAA delivery options (recommendation: option A for v1):**

| Option | Mechanism | Pros | Cons |
|--------|-----------|------|------|
| **A (recommended v1)** | SQAA protocol embedded in Sonar MCP server instructions / tool descriptions surfaced every session | Zero per-repo files; works in cloud agents | Relies on agent reading MCP context; may miss if MCP not invoked |
| **B** | Verify/adopt `~/.cursor/rules/` global support if Cursor adds or documents it | Native always-apply rule | Depends on undocumented/unstable Cursor feature |
| **C** | Accept minimal global rule file at `~/.cursor/rules/sonar-agentic-analysis.mdc` if writable | Closest to current per-repo delivery | May not apply to cloud agents; needs Cursor validation |

Implementation should ship A; spike B/C in parallel.

### 9.2 Claude Code

| Concern | Approach |
|---------|----------|
| Global MCP | `~/.claude.json` |
| Global secrets hooks | `~/.claude/settings.json` via `createSonarSecretsHooksFeature` |
| SQAA PostToolUse hook | Global `~/.claude/settings.json`; hook command without `--project` |
| SQAA end-of-turn instructions | Global `~/.claude/CLAUDE.md` snippet (project-agnostic template) |
| CAG | Global `~/.claude/skills/sonar-context-augmentation/SKILL.md` |

Claude is the best-fit agent for full runtime model — global hooks return `additionalContext` and global instructions are supported.

### 9.3 Codex

| Concern | Approach |
|---------|----------|
| Global MCP | `~/.codex/config.toml` |
| Global secrets hooks | `~/.codex/hooks.json` |
| SQAA PostToolUse hook | Global hooks.json; runtime project resolution |
| CAG | Global `~/.agents/skills/sonar-context-augmentation/SKILL.md` |

### 9.4 Copilot

| Concern | Approach |
|---------|----------|
| Global MCP | `~/.copilot/mcp-config.json` |
| Global secrets hooks | `~/.copilot/hooks/hooks.json` |
| SQAA instructions | Global `~/.copilot/instructions/sonarqube.instructions.md` (no baked project key) |
| CAG | Global `~/.github/skills/sonar-context-augmentation/SKILL.md` (under homedir) |

### 9.5 Antigravity

| Concern | Approach |
|---------|----------|
| MCP | Always global: `~/.gemini/config/mcp_config.json` |
| Global secrets hook | `~/.gemini/config/hooks.json` |
| SQAA rule | Global `~/.agents/rules/sonar-agentic-analysis.md` (under `~/.gemini/config/` target root) |
| Prompt-secrets | Global `~/.gemini/GEMINI.md` snippet |
| CAG | Global `~/.gemini/config/skills/sonar-context-augmentation/SKILL.md` |

Uses `resolveAntigravityInstallTarget()` — global `targetRoot` = `~/.gemini/config/`.

### 9.6 Git

**Not** part of machine onboard v1. Optional:

```bash
sonar onboard --with-git   # sets preference only
sonar integrate git -p <key>  # explicit per repo
```

Git hooks require a baked project key and repo-local hook file — incompatible with pure runtime model.

### 9.7 CAG daemon exception

CAG maintains a per-project daemon socket. This is the one runtime side effect that is inherently per-repo:

- **User action required:** none.
- **When:** first `sonar context` call (or first CAG tool use via MCP) in a workspace.
- **What:** daemon starts, caches connection metadata, reuses on subsequent calls.
- **Spec treatment:** classified as runtime bootstrap, not lazy bind. No files written into the repo.

---

## 10. Agent detection

**Module:** `src/lib/detect-installed-agents.ts`

| Agent | Heuristic |
|-------|-----------|
| Cursor | `exists(~/.cursor/)` or `CURSOR_*` in env |
| Claude | `exists(~/.claude.json)` or `exists(~/.claude/)` |
| Codex | `exists(~/.codex/)` |
| Copilot | `exists(~/.copilot/)` or `.github/copilot-instructions.md` pattern |
| Antigravity | `exists(~/.gemini/antigravity/)` or `.agents/` |

`detectCallerAgent()` used only to **sort** interactive multi-select (caller first), not as sole detector.

---

## 11. Implementation plan

### Phase 1 — Machine onboard (MVP)

- [ ] `sonar onboard` command in `command-tree.ts`
- [ ] `detectInstalledAgents()`
- [ ] `runMachineOnboard()` orchestrator — global `installIntegration` per agent with `--global` semantics
- [ ] Enable SQAA + CAG features at global scope (remove `resolveSqaaSetup` / `resolveContextAugmentationSetup` global rejection)
- [ ] Project-agnostic global SQAA templates (`buildSqaaSectionBody()` without required `projectKey`)
- [ ] Global SQAA hook commands without `--project` (`formatSqaaPostToolHookCommandUnix`)
- [ ] Shared preflight extracted from `displayAgentIntegratePrelude` (auth, entitlement cache)
- [ ] Machine profile persistence
- [ ] Update root `QUICKSTART` in `root-help.ts`
- [ ] Integration tests: onboard installs global MCP + hooks + SQAA for fake Cursor/Claude layout

### Phase 2 — Runtime resolution

- [ ] `resolveRuntimeProjectContext()` + positive/negative cache
- [ ] Wire call sites: SQAA hook handlers, `analyze agentic`, `runMcp`, `context` passthrough
- [ ] `resolveSqaaProjectKey` → discovery-first (state as fallback only)
- [ ] Global CAG skill install + runtime daemon bootstrap in context passthrough
- [ ] Cursor SQAA via MCP instructions (option A)
- [ ] Integration tests: fresh Sonar repo with **no per-repo Sonar files** → SQAA hook resolves project and runs
- [ ] Integration tests: non-Sonar repo → hook fires, fast no-op, no errors

### Phase 3 — Observability

- [ ] `sonar projects list` (configured + recently resolved repos)
- [ ] `sonar doctor --fix`
- [ ] Post-auth nudge after `sonar auth login`
- [ ] Update `CLAUDE.md` / `AGENTS.md`

### Phase 4 — Polish

- [ ] `--scan` for projects list
- [ ] Auto `doctor --fix` hint on `sonar self-update`
- [ ] Telemetry: `OnboardCompleted`, `RuntimeProjectResolved`, `RuntimeProjectSkipped` events
- [ ] Cursor global rules spike (options B/C)

---

## 12. Telemetry

| Event | When | Key fields |
|-------|------|------------|
| `CliOnboardCompleted` | `sonar onboard` success | `agents[]`, `preset`, `duration_ms` |
| `CliRuntimeProjectResolved` | runtime resolver finds project | `trigger`, `source`, `repo_id` (hashed) |
| `CliRuntimeProjectSkipped` | runtime resolver no-op | `reason`, `trigger`, `repo_id` (hashed) |

No project keys in telemetry payloads — use `repo_id` hash only.

---

## 13. Error handling

| Scenario | Behavior |
|----------|----------|
| Not authenticated | `onboard` fails with remediation; runtime resolution returns `skipped_no_auth`; secrets still work |
| SQAA not entitled | Machine onboard skips SQAA global features; runtime SQAA no-ops; secrets + MCP still work |
| CAG not entitled | Skip silently at onboard; runtime CAG no-ops (cloud warn per existing rules) |
| No Sonar config in repo | Runtime resolver writes negative cache; fast no-op; agent unaffected |
| Multiple Sonar projects in one repo | `discoverProject` winner; `--project` still overrides |
| Stale cache after config change | TTL expiry (1h positive); manual `sonar doctor --fix` clears cache |

---

## 14. Security

- Machine onboard writes only to global agent config dirs and `~/.sonar/sonarqube-cli/` — never into project repos.
- Never auto-write git hooks without opt-in.
- Runtime resolver reads repo config files only; no writes into project tree.
- Negative cache prevents repeated API calls / discovery walks in non-Sonar repos.
- Hook latency: target p95 &lt;500ms for cold resolution; &lt;10ms for cached negative.

---

## 15. Testing strategy

### Integration tests (primary)

- `tests/integration/specs/onboard/machine-onboard.test.ts` — global artifacts created (MCP, secrets, SQAA hooks/instructions)
- `tests/integration/specs/onboard/runtime-resolution.test.ts` — SQAA hook in fresh Sonar repo resolves project without per-repo files
- `tests/integration/specs/onboard/runtime-no-config.test.ts` — hook in non-Sonar repo → fast no-op, no repo files written
- `tests/integration/specs/onboard/runtime-cache.test.ts` — second invocation hits cache; negative cache prevents rediscovery
- `tests/integration/specs/onboard/analyze-agentic-discovery.test.ts` — `sonar analyze agentic --depth DEEP` without `--project`

### Unit tests

- `detectInstalledAgents`
- `resolveRuntimeProjectContext` — cache hit/miss, negative cache, entitlement gating
- Project resolution order in `sqaa-auth.ts`
- Global SQAA template renders without project key
- Global hook command format omits `--project`

---

## 16. Documentation updates

When implemented, update:

- `CLAUDE.md` — onboard section, runtime resolution, quickstart
- `AGENTS.md` — same
- Root help quickstart: `auth → onboard → projects list`
- Per-agent integrate docs: "prefer `sonar onboard`; use `integrate <agent>` for repair or legacy per-repo installs"

---

## 17. Open questions

| # | Question | Proposal |
|---|----------|----------|
| 1 | Cursor SQAA delivery without per-repo rules? | **MCP instructions (option A) for v1**; spike global rules path |
| 2 | Re-onboard on `sonar self-update`? | Auto `doctor --fix` refreshes global paths and hook binary references |
| 3 | Monorepo / nested roots | Resolve at git root only; same as existing SQAA |
| 4 | Legacy per-repo integrates coexist? | Yes — runtime resolver falls back to integration state; `integrate <agent>` remains |
| 5 | Rename `integrate`? | Keep; onboard is the recommended path |
| 6 | CAG daemon bootstrap latency on first call? | Accept; show debug log only; cache daemon handle per git root |
| 7 | Global SQAA for Claude: hooks + instructions or hooks only? | Both — hooks for per-edit STANDARD; global instructions for end-of-turn DEEP |

---

## 18. Acceptance criteria

- [ ] User with Cursor + Claude runs `sonar auth login` + `sonar onboard` once; both agents show Sonar MCP in settings.
- [ ] User clones a new repo with `sonar-project.properties`, opens in Cursor, sends a prompt; secrets scan works; no Sonar files appear in the repo.
- [ ] SQAA runs (Claude hook or agent-invoked analyze) without user passing `--project` and without prior `sonar integrate` in that repo.
- [ ] Repo without Sonar config: no errors, no spurious files in repo, hooks complete in &lt;50ms (cached).
- [ ] `sonar doctor --fix` repairs stale hook binary path after `sonar self-update`.
- [ ] `sonar integrate cursor` still works for manual repair / legacy per-repo installs.
- [ ] `sonar analyze agentic --depth DEEP` discovers project key from repo config when `--project` is omitted.

---

## Appendix A: Comparison with LeanCTX

| LeanCTX | SQ CLI (this spec) |
|---------|-------------------|
| `lean-ctx onboard` wires global MCP + hooks | `sonar onboard` wires global MCP + hooks + SQAA + CAG |
| Runtime cwd for all reads | Runtime `resolveRuntimeProjectContext(cwd)` for MCP + analyze + context |
| No per-repo install files | **No per-repo install files** (runtime resolution) |
| `lean-ctx doctor --fix` | `sonar doctor --fix` |
| Multi-repo via runtime cwd | Multi-repo via runtime project discovery per git root |

---

## Appendix B: Quick reference

```bash
# Once per machine
sonar auth login
sonar onboard

# Verify
sonar projects list
sonar doctor

# Repair
sonar doctor --fix

# Power user / legacy per-repo
sonar integrate cursor --project my-key

# CI
sonar onboard --non-interactive --yes
```

---

## Appendix C: Migration from lazy-bind draft

This spec **replaces** the lazy per-repo bind model (`ensureRepoReady`, `bindRepoSilent`, per-repo `.cursor/rules/` writes) with runtime resolution. Key differences:

| Lazy bind (previous draft) | Runtime resolution (this spec) |
|---------------------------|-------------------------------|
| Writes per-repo files on first agent activity | No per-repo file writes |
| `ensureRepoReady()` + file lock | `resolveRuntimeProjectContext()` + cache |
| SQAA rules in `.cursor/rules/` | Global delivery + MCP instructions (Cursor) |
| CAG skill per repo | Global skill + runtime daemon bootstrap |
| State tracks "bound" repos | State tracks machine profile + optional resolution cache |
| User invisible bind step | User invisible resolution step |

Existing per-repo `sonar integrate` installs remain compatible via state fallback in the runtime resolver.
