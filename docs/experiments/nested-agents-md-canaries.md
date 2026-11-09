# Nested `AGENTS.md` loading experiment

This branch removes repository-root `CLAUDE.md` files and uses only `AGENTS.md`. Nested guidance lives in directory-local `AGENTS.md` files (formerly `CLAUDE.md`).

The goal is to learn whether **Claude Code**, **Cursor**, and other agents automatically load a nested `AGENTS.md` when you work on files under that directory—without you `@`-mentioning the file.

## Canary codewords

Each nested `AGENTS.md` starts with an HTML comment and a probe instruction. The codeword is unique per directory:

| Directory | Codeword | Suggested file to open or edit |
| --- | --- | --- |
| `src/commands/` | `CANARY-COMMANDS-ORCHID` | `src/commands/command-tree.ts` |
| `src/commands/components/` | `CANARY-COMPONENTS-MAPLE` | any file under `src/commands/components/` |
| `src/commands/integrate/` | `CANARY-INTEGRATE-COBALT` | `src/commands/integrate/claude/declaration.ts` |
| `src/commands/quality-gate/` | `CANARY-QG-SAFFRON` | `src/commands/quality-gate/status.ts` (or sibling) |
| `src/core/framework/` | `CANARY-FRAMEWORK-JADE` | `src/core/framework/integration-engine.ts` (or sibling) |
| `src/core/stats/` | `CANARY-STATS-PLUM` | `src/core/stats/stats-queries.ts` |
| `src/core/telemetry/` | `CANARY-TELEMETRY-CORAL` | `src/core/telemetry/telemetry-ingest-key.ts` |
| `src/core/update/` | `CANARY-UPDATE-IVORY` | `src/core/update/check.ts` (or sibling) |
| `tests/` | `CANARY-TESTS-UMBER` | `tests/integration/harness/test-harness.ts` (or sibling) |

List codewords from the repo:

```bash
./scripts/list-nested-agents-canaries.sh
```

## How to run the probe

Use a **fresh agent session** (no prior context) on this branch.

1. Open or `@`-reference a file from the “Suggested file” column (not the `AGENTS.md` itself).
2. Send exactly:

   ```text
   Run the nested-AGENTS probe for <path/to/AGENTS.md from the table>. Reply with only: LOADED=<codeword> or NOT_LOADED=unknown
   ```

   Example:

   ```text
   Run the nested-AGENTS probe for src/core/stats/AGENTS.md. Reply with only: LOADED=CANARY-STATS-PLUM or NOT_LOADED=unknown
   ```

3. **Interpretation**
   - `LOADED=<codeword>` → nested `AGENTS.md` was likely in context (or the model guessed from the prompt—compare with a control where you remove the canary line and re-run).
   - `NOT_LOADED=unknown` → nested file was not loaded automatically.

## Controls and gotchas

- **Root `AGENTS.md`** is still expected to load in Cursor and similar tools at session start; this experiment is only about **nested** files.
- **Claude Code** may still use `.claude/rules/*.md` with `paths:` globs; those are unchanged.
- **`sonar integrate claude`** still writes the end-user project file `CLAUDE.md` (product behavior, not this repo layout).
- For stronger evidence, enable the agent’s verbose context / rules trace (when available) and check whether `src/core/stats/AGENTS.md` appears in the injected rules list.

## What we are not testing

Integration tests under `tests/integration/specs/integrate/` that assert on `~/.claude/CLAUDE.md` are unchanged—they validate CLI output for Claude Code users, not this repository’s doc filenames.
