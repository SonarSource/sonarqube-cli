# Local analyzer statistics

- The SQLite ledger is local-only and must never be transmitted. `stats.enabled` is independent of telemetry consent and `DO_NOT_TRACK`; an unreadable config disables collection.
- Use `ctx.recordStats(() => buildStatsFromTelemetry(fact, details))`. Defer deduplication and detail computation inside the factory so disabled collection performs no producer work. `postAction` commits buffered facts synchronously.
- Core must not import commands. Keep analyzer classifications and payload types compatible across the boundary using structural types and existing builders.
- Ledger operations are best-effort. Failure to check seen findings falls back to **everything is new**, never zero. Insert an analyzer event and update its aggregates in one transaction.
- Set SQLite busy timeout before converting to WAL. Use immediate transactions for migrations and read-then-write deduplication so simultaneous CLI processes cannot race schema creation or fingerprint claims.
- Quarantine only actual SQLite corruption; ordinary errors must not delete history. Purging raw events must retain all-time aggregates and rule descriptions; schema upgrades must backfill existing analyzer history.
- Use `useTempSonarUserHome()` and the shared stats assertion helpers in tests. Use `removeTestSonarUserHome()` for Windows-safe WAL/SHM cleanup. Read [test guidance](../../../tests/AGENTS.md).
