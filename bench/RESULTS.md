# Storage backend benchmark results
## Machine
- Platform: darwin/arm64
- Bun: 1.3.14
- RAM: 36.0 GiB
- Completed scales: 1,000,000, 10,000,000, 100,000,000
- **Note**: the 100,000,000-record stage exceeded the 10-minute per-stage budget. Any further requested scales beyond it were not run.
## Scale in context

Assumption: one agent works 8h/day, 220 workdays/year, and triggers a hook roughly every 6s while working (6,336,000 working seconds/year).

- **1M** ≈ 1,056,000 events/agent/year → **one agent, one full year** of normal working-hours usage.
- **10M** ≈ 9.5 agent-years → e.g. **5 agents working in parallel for 2 years**.
- **100M** ≈ 95 agent-years — implausible for a single-machine ledger under normal human-triggered usage. Squeezed into one working-year it would need a sustained ~15.8 events/second, every working second, all year — only reachable via a continuously-running script or synthetic seeding, which is exactly how this benchmark produces it. Included as an upper-bound stress test, not a realistic single-machine scenario.

## Load (write throughput + storage footprint)
| backend | scale | load time | size on disk |
| --- | --- | --- | --- |
| sqlite-json1 | 1,000,000 | 2.34 s | 0.23 GiB |
| lmdb | 1,000,000 | 3.59 s | 0.32 GiB |
| ndjson | 1,000,000 | 570.84 ms | 0.21 GiB |
| sqlite-json1 | 10,000,000 | 24.59 s | 2.26 GiB |
| lmdb | 10,000,000 | 37.03 s | 3.20 GiB |
| ndjson | 10,000,000 | 5.33 s | 2.15 GiB |
| sqlite-json1 | 100,000,000 | 277.01 s | 22.72 GiB |
| lmdb | 100,000,000 | 388.42 s | 32.01 GiB |
## Query latency (median of repetitions, fresh handle per repetition)
| backend | scale | query | median latency |
| --- | --- | --- | --- |
| sqlite-json1 | 1,000,000 | totals(30d) | 15.72 ms |
| sqlite-json1 | 1,000,000 | analyzerBreakdown(30d) | 28.17 ms |
| sqlite-json1 | 1,000,000 | topRules(30d) | 60.50 ms |
| sqlite-json1 | 1,000,000 | allTimeTotals() | 64.91 ms |
| lmdb | 1,000,000 | totals(30d) | 10.66 ms |
| lmdb | 1,000,000 | analyzerBreakdown(30d) | 8.46 ms |
| lmdb | 1,000,000 | topRules(30d) | 120.61 ms |
| lmdb | 1,000,000 | allTimeTotals() | 105.37 ms |
| ndjson | 1,000,000 | totals(30d) | 598.44 ms |
| ndjson | 1,000,000 | analyzerBreakdown(30d) | 611.82 ms |
| ndjson | 1,000,000 | topRules(30d) | 612.89 ms |
| ndjson | 1,000,000 | allTimeTotals() | 613.67 ms |
| sqlite-json1 | 10,000,000 | totals(30d) | 183.32 ms |
| sqlite-json1 | 10,000,000 | analyzerBreakdown(30d) | 341.74 ms |
| sqlite-json1 | 10,000,000 | topRules(30d) | 681.22 ms |
| sqlite-json1 | 10,000,000 | allTimeTotals() | 681.31 ms |
| lmdb | 10,000,000 | totals(30d) | 83.29 ms |
| lmdb | 10,000,000 | analyzerBreakdown(30d) | 83.42 ms |
| lmdb | 10,000,000 | topRules(30d) | 1.17 s |
| lmdb | 10,000,000 | allTimeTotals() | 978.49 ms |
| ndjson | 10,000,000 | totals(30d) | 6.16 s |
| ndjson | 10,000,000 | analyzerBreakdown(30d) | 6.13 s |
| ndjson | 10,000,000 | topRules(30d) | 6.27 s |
| ndjson | 10,000,000 | allTimeTotals() | 6.13 s |
| sqlite-json1 | 100,000,000 | totals(30d) | 1.86 s |
| sqlite-json1 | 100,000,000 | analyzerBreakdown(30d) | 3.67 s |
| sqlite-json1 | 100,000,000 | topRules(30d) | 6.92 s |
| sqlite-json1 | 100,000,000 | allTimeTotals() | 40.24 s |
| lmdb | 100,000,000 | totals(30d) | 815.23 ms |
| lmdb | 100,000,000 | analyzerBreakdown(30d) | 838.81 ms |
| lmdb | 100,000,000 | topRules(30d) | 12.43 s |
| lmdb | 100,000,000 | allTimeTotals() | 9.76 s |
