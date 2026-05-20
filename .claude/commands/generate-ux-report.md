Generate a UX output report for the SonarQube CLI.

This command produces `docs/cli-output-report.md` — a human-readable document showing the actual terminal output for every meaningful CLI scenario, organized by section. No credentials, no running servers, no setup required beyond having the project checked out.

---

## Before you start

This command takes 1–3 minutes depending on whether the CLI binary needs to be compiled. It is completely self-contained: it spins up fake servers internally and cleans them up afterwards. It is safe to run at any time and does not modify any source files (only `docs/cli-output-report.md` and potentially `build-scripts/ux-report/generate-ux-report.ts` if new scenarios are discovered).

---

## Exploring the codebase — keep it simple

When reading files to understand what exists, use only `Read` and basic `find`. Do not write analysis scripts or chain bash commands together. The goal is that every tool use is readable at a glance by someone non-technical watching the process.

Good:
- `Read build-scripts/ux-report/generate-ux-report.ts` — see what's already covered
- `find tests/integration/specs -name "*.test.ts"` — list test files to review
- `Read tests/integration/specs/auth/auth.test.ts` — read one test file

Avoid:
- Piped grep commands, awk, sed, inline scripts
- Running any bun/node scripts just to extract information

---

## Steps

### Step 1 — Understand current coverage

Read `build-scripts/ux-report/generate-ux-report.ts` from top to bottom. This file is the single source of truth for the report. Each `uxDescribe('Section Name', ...)` is a report section; each `uxIt('label', ...)` inside it is one captured scenario.

Make a mental note of what commands and paths are already covered.

### Step 2 — Find missing scenarios

List the test files in `tests/integration/specs/` with `find`. Then read the ones for commands or areas not yet well-covered in the UX report. You are looking for:

**Include:**
- Commands or subcommands with no scenarios at all in the report
- Clearly distinct success paths whose terminal output looks meaningfully different from existing scenarios
- Error messages a user would actually act on (e.g. "run `sonar auth login`", "not eligible", "requires Cloud connection")

**Skip — these will never produce useful output in the fake server environment:**
- `hook *` subcommands — internal, called by other tools, not by users
- `run mcp` and `flush-telemetry` — internal infrastructure commands
- `self-update` — fetches from GitHub; no env-var override exists to redirect it to a fake server
- Paths that require a real SCA or SonarQube backend to return meaningful data (the fake server's SCA scanner always fails with an invocation error — it can show the install step but not a real scan result)
- Minor flag variations (e.g. `--page 2`) that produce output nearly identical to an existing scenario

### Step 3 — Add missing scenarios to the report file

For each approved gap, add a `uxIt()` entry to the appropriate `uxDescribe()` block in `build-scripts/ux-report/generate-ux-report.ts`.

Follow the patterns already in the file:

```typescript
// Simple — works when the describe block has a shared server set up in beforeEach
uxIt('label describing what the user sees', () => harness.run('some command here'));

// Complex — use when this scenario needs a differently-configured server than the others in its group
uxIt('label', () =>
  withHarness(async (h) => {
    const server = await h.newFakeServer().withAuthToken(TOKEN).start();
    h.state().withAuth(server.baseUrl(), TOKEN);
    return h.run('some command here');
  }),
);

// Long-running — use for scenarios that take more than 30 seconds (large changeset, binary download)
uxIt('label', () => withHarness(async (h) => { ... }), { timeout: 60000 });
```

Key rules when editing the file:
- `uxDescribe` callback must set up a server + auth in `beforeEach` if the scenarios inside need one; otherwise use `withHarness` per scenario
- The `TOKEN`, `ORG`, `PROJECT`, and `ORG_UUID` constants are defined at the top of the file — use them
- **Fixture tokens** (real-looking but fake credential strings used to trigger secret detection, e.g. a fake GitHub token): do **not** put them inline in `generate-ux-report.ts`. Store them in a companion file `build-scripts/ux-report/ux-report-fixtures.ts` and import from there. This keeps `generate-ux-report.ts` free of strings that trigger the secrets scanning hook, which would otherwise block the file from being read or edited.
- If `ux-report-fixtures.ts` does not yet exist, create it with `Write`. If it already exists, **do not try to read it** — the secrets hook will block the read. Instead, delete it and recreate it from scratch with `Write`, preserving any fixture values you know about plus the new ones you need to add. Each fixture value must have a `// sonar-ignore-next-line S6769` annotation on the line above it.
- After editing, run `bun x prettier --write build-scripts/ux-report/generate-ux-report.ts` to format

If a TypeScript error appears after editing, fix it before proceeding — the report will not generate with compile errors.

### Step 4 — Build the CLI binary

Run:
```
bun run pretest:integration
```

This compiles the CLI binary (`dist/sonarqube-cli`) and downloads the `sonar-secrets` and `sca-scanner-cli` test binaries into `tests/integration/resources/`. It is safe to rerun — already-built artifacts are reused and the step typically finishes in under a minute when nothing has changed.

**If this step fails:**
- "bun: command not found" → bun is not installed. Ask the user to install it: https://bun.sh
- "permission denied" → the build output directory may need write permission; ask the user to check `dist/`
- Any other error → show the last 20 lines of output and ask the user whether to retry or stop

### Step 5 — Generate the report

Run:
```
bun test ./build-scripts/ux-report/generate-ux-report.ts
```

This runs all scenarios in `build-scripts/ux-report/generate-ux-report.ts` (takes 20–60 seconds) and writes `docs/cli-output-report.md`.

**If this step fails:**
- If individual test cases fail, the report is still written with the scenarios that succeeded. Check whether the failure is in a newly added scenario (fix it and rerun) or a pre-existing one (note it to the user and continue)
- If the whole suite crashes before writing the report, show the error and ask the user whether to retry

### Step 6 — Report to the user

Read the first 10 lines of the generated `docs/cli-output-report.md` to extract the scenario count (the line `> **Total runs captured:** N`).

Tell the user in plain language:
- How many scenarios are in the report
- How many new ones were added in this run (0 if none)
- Where the file is: `docs/cli-output-report.md` relative to the project root
- How to view it: open it in VS Code (renders markdown inline), any browser with a markdown extension, or any markdown viewer

Example summary:
> Done! The report has **102 scenarios** across 14 sections (3 newly added).
> File: `docs/cli-output-report.md`
> Open it in VS Code or any markdown viewer to share it with your team.
