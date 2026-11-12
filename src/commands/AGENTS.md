# Commands

- Declare commands with `SonarCommand` from `src/core/commands/sonar-command.ts` and register them in `createCommandTree()` or its delegated registration modules. Prefer `authenticatedAction()`; reserve `anonymousAction()` for technical commands.
- Use invocation contexts for auth, the connection, lifecycle eligibility, telemetry, and stats. Resolve credentials with `ctx.resolveAuth()`; hooks/status may use `resolveAuthOrNull()` or `resolveConnection()` to degrade gracefully. Authenticated handlers already have `ctx.auth` and `ctx.connection`.
- Gate every prompt with `console.canPrompt()`: prompt methods do not check and may wait forever on piped/closed stdin. Give noninteractive callers an explicit outcome. Test with `FakeConsole.setCanPrompt(false)`; integration prompt flows require `SONARQUBE_CLI_MOCK_TTY=1`.
- Declare lifecycle on commands and options with `Stage`. Private Beta requires its flag key; Deprecated requires `sinceVersion` and `replacement` (explicit `null` if absent). Resolve flags before refreshing staged visibility. Public docs omit Alpha and Private Beta.
- Visible top-level commands declare `rootHelp({ category, order })`; metadata controls section and row order. Reuse the existing help renderer and shared console components.
- Record facts on the invocation context; let `postAction` commit telemetry and stats. Domain payloads belong beside producers. See [telemetry](../core/telemetry/AGENTS.md) and [stats](../core/stats/AGENTS.md) before changing their lifecycle.
- Read [updates](../core/update/AGENTS.md) before changing root startup hooks; initialization depends on migrated consent.
- Follow the root error-handling conventions. Use `remediationHint` for separate actionable recovery guidance.
- Read [integration guidance](integrate/AGENTS.md) for `integrate/`, `hook/`, `context/`, and `analyze/`; [components](components/AGENTS.md) for shared UI; [quality gates](quality-gate/AGENTS.md) for status scoping. Read the root's state/auth and API routes for those concerns.
- Repository imports are create-only. Treat an existing project as a no-op only after its binding matches the selected setting and repository; never upsert on creation conflicts. Report truncated discovery as incomplete rather than claiming success or not found.
- Onboarding must not create a second project when linking an existing one cannot prompt or persist its mapping.
- Require an explicit scan request before downloading or running an external scanner. Pin endpoints and managed settings from the active connection so repository configuration cannot redirect credentials. Keep tokens and sensitive property values out of process arguments; preserve log redaction and detached-run restrictions.
- Organization billing setup may follow only an organization created by the current invocation. Never interpret transient subscription lookup failures as an absent subscription.
- Architecture commands use public APIs only. Intended-model writes reject partial exports and save owner-only backups; directive batches preflight before writing and report confirmed partial results without automatic retry or rollback.
- Prefer integration tests using the existing harness. Read [test guidance](../../tests/AGENTS.md) before adding or modifying tests.
