# Telemetry and observability

Read [test guidance](../../../tests/AGENTS.md), including all four telemetry isolation safeguards, before writing tests that touch telemetry or Sentry.

- Core transport is event-agnostic; domain payloads belong beside producers. Handlers buffer `TelemetryFact`s on the invocation context; `postAction` commits them with `CliCommandExecuted` and schedules flushing. Framework installs report success through callbacks rather than importing command telemetry.
- Keep consent (`telemetry.enabled` and `DO_NOT_TRACK`) separate from egress (`__SQ_CLI_TELEMETRY_EGRESS`). Unset/empty egress means production; **every other value means off**. Off must prevent detached workers, queue draining, and Sentry transmission. `flushTelemetryEvents()` itself has no guard.
- Resolve identity from the invocation's auth; environment credentials must not seed from a saved connection. Cache successful values and confirmed absence (`null`), but never transient failures. Store events use existing connection identity without network enrichment.
- A target project is a server+project pair the command touched. Each run emits one `CliCommandExecuted` with `target_project_count`, plus one `CliTargetProjectResolved` per target project carrying its `project_uuid` (the legacy Sonar component identifier) and that project's own server identity. With more than one target project, the command event has no `project_uuid` or server identity. Note resolved projects through the shared ambient context and reset that context between tests.
- Telemetry argument descriptions may include values only for fixed `.choices()` sets. Free-valued options/positionals emit their names only; never record credentials or arbitrary user input.
- Network-config failures abort/requeue the entire flush batch rather than repeatedly attempting individual events. Outward traffic, including Sentry and flag evaluation, follows the root network rules.
- Never open, print, or copy `telemetry-ingest-key.ts`. Only `telemetry-events.ts` may import its constant; keep endpoint/key imports within the lint-enforced owners.
- Changes to startup consent handling require [update guidance](../update/AGENTS.md). Identity/auth changes also require [state/auth guidance](../../../docs/development/agent-guidance/state-and-auth.md).
