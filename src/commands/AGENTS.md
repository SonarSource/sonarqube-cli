# Commands

- Declare commands with `SonarCommand` from `src/core/commands/sonar-command.ts` and register them in `createCommandTree()` or its delegated registration modules. Prefer `authenticatedAction()`; reserve `anonymousAction()` for technical commands.
- Use invocation contexts for auth, the connection, lifecycle eligibility, telemetry, and stats. Resolve credentials with `ctx.resolveAuth()`; hooks/status may use `resolveAuthOrNull()` or `resolveConnection()` to degrade gracefully. Authenticated handlers already have `ctx.auth` and `ctx.connection`.
- Gate every prompt with `console.canPrompt()`: prompt methods do not check and may wait forever on piped/closed stdin. Give noninteractive callers an explicit outcome. Test with `FakeConsole.setCanPrompt(false)`; integration prompt flows require `SONARQUBE_CLI_MOCK_TTY=1`.
- Declare lifecycle on commands and options with `Stage`. Private Beta requires its flag key; Deprecated requires `sinceVersion` and `replacement` (explicit `null` if absent). Resolve flags before refreshing staged visibility. Public docs omit Alpha and Private Beta.
- Visible top-level commands declare `rootHelp({ category })`; declaration order controls display order. Reuse the existing help renderer and shared console components.
- Record facts on the invocation context; let `postAction` commit telemetry and stats. Domain payloads belong beside producers. See [telemetry](../core/telemetry/AGENTS.md) and [stats](../core/stats/AGENTS.md) before changing their lifecycle.
- Read [updates](../core/update/AGENTS.md) before changing root startup hooks; initialization depends on migrated consent.
- Use the production error classes and exit codes specified in the root instructions. Use `remediationHint` for separate actionable recovery guidance.
- Read [integration guidance](integrate/AGENTS.md) for `integrate/`, `hook/`, `context/`, and `analyze/`; [components](components/AGENTS.md) for shared UI; [quality gates](quality-gate/AGENTS.md) for status scoping. Read the root's state/auth and API routes for those concerns.
- Repository imports are create-only. Treat an existing project as a no-op only after its binding matches the selected setting and repository; never upsert on creation conflicts. Report truncated discovery as incomplete rather than claiming success or not found.
- Onboarding must not create a second project when linking an existing one cannot prompt or persist its mapping.
- Architecture commands use public APIs only. Intended-model writes reject partial exports and save owner-only backups; directive batches preflight before writing and report confirmed partial results without automatic retry or rollback.
- Prefer integration tests using the existing harness. Read [test guidance](../../tests/AGENTS.md) before adding or modifying tests.
