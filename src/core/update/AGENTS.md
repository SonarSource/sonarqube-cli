# Updates and migrations

- `post-update.ts` orchestrates upgrade migrations from the root `preAction` hook **before Sentry initialization**, so legacy telemetry opt-out reaches config before observability reads consent. Help/version exit without running actions.
- Preserve dependency order: migrate legacy keychain tokens before any migration resolves memoized auth; capture known project mappings before declarative/global reconciliation discards per-folder attributes; migrate telemetry consent before Sentry starts.
- Finish slow reconciliation outside state locks, then merge the resulting feature changes into the latest state through one `updateState()` callback. Read [state/auth guidance](../../../docs/development/agent-guidance/state-and-auth.md) and [framework guidance](../framework/AGENTS.md).
- Standalone self-update requires both the distribution capability and the canonical installer location; the build marker alone cannot establish installation ownership. Preserve read-only status from other locations and give manager/original-install-method guidance there.
- Migration retry advice must match the installation method. A spent version gate must not prevent the supported global migration retry.
- Read [build guidance](../../../build-scripts/AGENTS.md) and [installer guidance](../../../user-scripts/AGENTS.md) when changing release compatibility.
