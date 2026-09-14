import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

import type { SyntheticStatsEvent } from '../gen/synthetic-event.ts';
import type {
  AnalyzerBreakdownRow,
  LoadResult,
  StatsBackend,
  TopRuleRow,
  TotalsResult,
} from './stats-backend.ts';

// Deliberately naive: no index of any kind. Every query is a full read + JSON.parse per line +
// in-process reduce, representing the "just append JSON lines" baseline this replaces.
async function forEachRecord(
  filePath: string,
  onRecord: (record: SyntheticStatsEvent) => void,
): Promise<void> {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    onRecord(JSON.parse(line) as SyntheticStatsEvent);
  }
}

export function createNdjsonBackend(filePath: string): StatsBackend {
  return {
    name: 'ndjson',

    async load(records: Iterable<SyntheticStatsEvent>): Promise<LoadResult> {
      if (existsSync(filePath)) rmSync(filePath, { force: true });

      const start = performance.now();
      const chunks: string[] = [];
      const CHUNK_FLUSH_LINES = 50_000;
      const writer = Bun.file(filePath).writer();
      for (const record of records) {
        chunks.push(JSON.stringify(record));
        if (chunks.length >= CHUNK_FLUSH_LINES) {
          writer.write(`${chunks.join('\n')}\n`);
          chunks.length = 0;
        }
      }
      if (chunks.length > 0) writer.write(`${chunks.join('\n')}\n`);
      await writer.end();

      const durationMs = performance.now() - start;
      const bytesOnDisk = statSync(filePath).size;
      return { durationMs, bytesOnDisk };
    },

    async totals(sinceMs: number): Promise<TotalsResult> {
      let runs = 0;
      let findings = 0;
      await forEachRecord(filePath, (record) => {
        if (record.timestampMs < sinceMs) return;
        runs++;
        findings += record.findingsCount;
      });
      return { runs, findings };
    },

    async analyzerBreakdown(sinceMs: number): Promise<AnalyzerBreakdownRow[]> {
      const byAnalyzer = new Map<string, { runs: number; findings: number }>();
      await forEachRecord(filePath, (record) => {
        if (record.timestampMs < sinceMs) return;
        const entry = byAnalyzer.get(record.analyzer) ?? { runs: 0, findings: 0 };
        entry.runs++;
        entry.findings += record.findingsCount;
        byAnalyzer.set(record.analyzer, entry);
      });
      return [...byAnalyzer.entries()].map(([analyzer, { runs, findings }]) => ({
        analyzer,
        runs,
        findings,
      }));
    },

    async topRules(sinceMs: number, minCount: number, limit: number): Promise<TopRuleRow[]> {
      const counts = new Map<string, number>();
      await forEachRecord(filePath, (record) => {
        if (record.timestampMs < sinceMs) return;
        for (const [ruleKey, count] of Object.entries(record.ruleCounts)) {
          counts.set(ruleKey, (counts.get(ruleKey) ?? 0) + count);
        }
      });
      return [...counts.entries()]
        .filter(([, count]) => count >= minCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([ruleKey, count]) => ({ ruleKey, count }));
    },

    async allTimeTotals(): Promise<TotalsResult> {
      let runs = 0;
      let findings = 0;
      await forEachRecord(filePath, (record) => {
        runs++;
        findings += record.findingsCount;
      });
      return { runs, findings };
    },

    close(): void {
      // stateless — nothing to close between calls
    },
  };
}
