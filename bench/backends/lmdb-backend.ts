import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { open, type Database as LmdbDatabase, type RootDatabase } from 'lmdb';

import type { SyntheticAnalyzer, SyntheticStatsEvent } from '../gen/synthetic-event.ts';
import type {
  AnalyzerBreakdownRow,
  LoadResult,
  StatsBackend,
  TopRuleRow,
  TotalsResult,
} from './stats-backend.ts';

const KNOWN_ANALYZERS: readonly SyntheticAnalyzer[] = ['sonar-secrets', 'sqaa', 'sca-scanner-cli'];
const BATCH_SIZE = 10_000;
const BYTES_PER_RECORD_BUDGET = 1500; // generous headroom across primary + 4 secondary indexes
const MIN_MAP_SIZE = 64 * 1024 * 1024;

type CompositeKey = [number, number];

interface Handles {
  root: RootDatabase;
  primary: LmdbDatabase<SyntheticStatsEvent, CompositeKey>;
  idxTime: LmdbDatabase<number, CompositeKey>;
  idxAnalyzer: Record<SyntheticAnalyzer, LmdbDatabase<number, CompositeKey>>;
}

export function createLmdbBackend(dbDir: string, estimatedRecords: number): StatsBackend {
  let handles: Handles | null = null;

  function openFresh(): Handles {
    const mapSize = Math.max(estimatedRecords * BYTES_PER_RECORD_BUDGET, MIN_MAP_SIZE);
    const root = open({ path: dbDir, mapSize });
    const primary = root.openDB({ name: 'primary' }) as LmdbDatabase<
      SyntheticStatsEvent,
      CompositeKey
    >;
    const idxTime = root.openDB({ name: 'idx_time' }) as LmdbDatabase<number, CompositeKey>;
    const idxAnalyzer = Object.fromEntries(
      KNOWN_ANALYZERS.map((analyzer) => [
        analyzer,
        root.openDB({ name: `idx_analyzer_${analyzer}` }) as LmdbDatabase<number, CompositeKey>,
      ]),
    ) as Record<SyntheticAnalyzer, LmdbDatabase<number, CompositeKey>>;
    return { root, primary, idxTime, idxAnalyzer };
  }

  return {
    name: 'lmdb',

    async load(records: Iterable<SyntheticStatsEvent>): Promise<LoadResult> {
      if (existsSync(dbDir)) rmSync(dbDir, { recursive: true, force: true });

      const start = performance.now();
      const h = openFresh();

      let batch: SyntheticStatsEvent[] = [];
      const flushBatch = () => {
        h.root.transactionSync(() => {
          for (const record of batch) {
            const key: CompositeKey = [record.timestampMs, record.id];
            h.primary.putSync(key, record);
            h.idxTime.putSync(key, record.findingsCount);
            h.idxAnalyzer[record.analyzer].putSync(key, record.findingsCount);
          }
        });
        batch = [];
      };

      for (const record of records) {
        batch.push(record);
        if (batch.length >= BATCH_SIZE) flushBatch();
      }
      if (batch.length > 0) flushBatch();

      handles = h;
      const durationMs = performance.now() - start;
      const bytesOnDisk = statSync(join(dbDir, 'data.mdb')).size;
      return { durationMs, bytesOnDisk };
    },

    async totals(sinceMs: number): Promise<TotalsResult> {
      handles ??= openFresh();
      let runs = 0;
      let findings = 0;
      for (const { value } of handles.idxTime.getRange({ start: [sinceMs, 0] })) {
        runs++;
        findings += value;
      }
      return { runs, findings };
    },

    async analyzerBreakdown(sinceMs: number): Promise<AnalyzerBreakdownRow[]> {
      handles ??= openFresh();
      const rows: AnalyzerBreakdownRow[] = [];
      for (const analyzer of KNOWN_ANALYZERS) {
        let runs = 0;
        let findings = 0;
        for (const { value } of handles.idxAnalyzer[analyzer].getRange({ start: [sinceMs, 0] })) {
          runs++;
          findings += value;
        }
        if (runs > 0) rows.push({ analyzer, runs, findings });
      }
      return rows;
    },

    async topRules(sinceMs: number, minCount: number, limit: number): Promise<TopRuleRow[]> {
      handles ??= openFresh();
      const counts = new Map<string, number>();
      for (const { value: record } of handles.primary.getRange({ start: [sinceMs, 0] })) {
        for (const [ruleKey, count] of Object.entries(record.ruleCounts)) {
          counts.set(ruleKey, (counts.get(ruleKey) ?? 0) + count);
        }
      }
      return [...counts.entries()]
        .filter(([, count]) => count >= minCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([ruleKey, count]) => ({ ruleKey, count }));
    },

    async allTimeTotals(): Promise<TotalsResult> {
      handles ??= openFresh();
      let runs = 0;
      let findings = 0;
      for (const { value } of handles.idxTime.getRange({})) {
        runs++;
        findings += value;
      }
      return { runs, findings };
    },

    close(): void {
      handles?.root.close();
      handles = null;
    },
  };
}
