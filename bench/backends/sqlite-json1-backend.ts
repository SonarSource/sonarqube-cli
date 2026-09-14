import { existsSync, rmSync, statSync } from 'node:fs';

import { Database } from 'bun:sqlite';

import type { SyntheticStatsEvent } from '../gen/synthetic-event.ts';
import type {
  AnalyzerBreakdownRow,
  LoadResult,
  StatsBackend,
  TopRuleRow,
  TotalsResult,
} from './stats-backend.ts';

const BATCH_SIZE = 10_000;

export function createSqliteJson1Backend(dbPath: string): StatsBackend {
  let db: Database | null = null;

  function openFresh(): Database {
    return new Database(dbPath, { create: true });
  }

  return {
    name: 'sqlite-json1',

    async load(records: Iterable<SyntheticStatsEvent>): Promise<LoadResult> {
      if (existsSync(dbPath)) rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });

      const start = performance.now();
      const writer = openFresh();
      writer.run('PRAGMA journal_mode = WAL');
      writer.run('PRAGMA synchronous = NORMAL');
      writer.run(`
        CREATE TABLE stats_events (
          id INTEGER PRIMARY KEY,
          timestamp_ms INTEGER NOT NULL,
          payload TEXT NOT NULL,
          analyzer TEXT GENERATED ALWAYS AS (json_extract(payload, '$.analyzer')) STORED,
          findings_count INTEGER GENERATED ALWAYS AS (json_extract(payload, '$.findingsCount')) STORED
        );
        CREATE INDEX idx_stats_events_timestamp ON stats_events (timestamp_ms);
        -- Deliberately no index on 'analyzer': none of the benchmarked queries filter by it as
        -- an equality predicate. An (analyzer, timestamp_ms) index was tried and measured as
        -- actively harmful at 100M rows — the planner preferred it for GROUP BY analyzer's
        -- ordering and turned the query into a full 100M-row index SCAN instead of an ~8.2M-row
        -- SEARCH on timestamp_ms, a >10x regression. Without it, GROUP BY falls back to a small
        -- in-memory temp b-tree over just the matching rows, which is far cheaper here.
      `);

      const insert = writer.prepare(
        'INSERT INTO stats_events (id, timestamp_ms, payload) VALUES (?, ?, ?)',
      );
      writer.run('BEGIN');
      let sinceLastCommit = 0;
      for (const record of records) {
        const payload = JSON.stringify({
          analyzer: record.analyzer,
          callerCommand: record.callerCommand,
          exitCode: record.exitCode,
          callerAgent: record.callerAgent,
          runTrigger: record.runTrigger,
          durationMs: record.durationMs,
          findingsCount: record.findingsCount,
          ruleCounts: record.ruleCounts,
        });
        insert.run(record.id, record.timestampMs, payload);
        sinceLastCommit++;
        if (sinceLastCommit >= BATCH_SIZE) {
          writer.run('COMMIT');
          writer.run('BEGIN');
          sinceLastCommit = 0;
        }
      }
      writer.run('COMMIT');
      writer.close();

      const durationMs = performance.now() - start;
      const bytesOnDisk = statSync(dbPath).size;
      return { durationMs, bytesOnDisk };
    },

    async totals(sinceMs: number): Promise<TotalsResult> {
      db ??= openFresh();
      const row = db
        .prepare<{ runs: number; findings: number }, [number]>(
          `SELECT COUNT(*) as runs, COALESCE(SUM(findings_count), 0) as findings
           FROM stats_events WHERE timestamp_ms >= ?`,
        )
        .get(sinceMs);
      return { runs: row?.runs ?? 0, findings: row?.findings ?? 0 };
    },

    async analyzerBreakdown(sinceMs: number): Promise<AnalyzerBreakdownRow[]> {
      db ??= openFresh();
      return db
        .prepare<AnalyzerBreakdownRow, [number]>(
          `SELECT analyzer, COUNT(*) as runs, COALESCE(SUM(findings_count), 0) as findings
           FROM stats_events WHERE timestamp_ms >= ? GROUP BY analyzer`,
        )
        .all(sinceMs);
    },

    async topRules(sinceMs: number, minCount: number, limit: number): Promise<TopRuleRow[]> {
      db ??= openFresh();
      return db
        .prepare<TopRuleRow, [number, number, number]>(
          `SELECT je.key as ruleKey, SUM(je.value) as count
           FROM stats_events e, json_each(e.payload, '$.ruleCounts') je
           WHERE e.timestamp_ms >= ?
           GROUP BY je.key
           HAVING SUM(je.value) >= ?
           ORDER BY count DESC LIMIT ?`,
        )
        .all(sinceMs, minCount, limit);
    },

    async allTimeTotals(): Promise<TotalsResult> {
      db ??= openFresh();
      const row = db
        .prepare<{ runs: number; findings: number }, []>(
          `SELECT COUNT(*) as runs, COALESCE(SUM(findings_count), 0) as findings
           FROM stats_events`,
        )
        .get();
      return { runs: row?.runs ?? 0, findings: row?.findings ?? 0 };
    },

    close(): void {
      db?.close();
      db = null;
    },
  };
}
