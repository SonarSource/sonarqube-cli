import type { SyntheticStatsEvent } from '../gen/synthetic-event.ts';

export interface LoadResult {
  durationMs: number;
  bytesOnDisk: number;
}

export interface TotalsResult {
  runs: number;
  findings: number;
}

export interface AnalyzerBreakdownRow {
  analyzer: string;
  runs: number;
  findings: number;
}

export interface TopRuleRow {
  ruleKey: string;
  count: number;
}

export interface StatsBackend {
  readonly name: string;
  load(records: Iterable<SyntheticStatsEvent>): Promise<LoadResult>;
  totals(sinceMs: number): Promise<TotalsResult>;
  analyzerBreakdown(sinceMs: number): Promise<AnalyzerBreakdownRow[]>;
  topRules(sinceMs: number, minCount: number, limit: number): Promise<TopRuleRow[]>;
  allTimeTotals(): Promise<TotalsResult>;
  close(): void;
}
