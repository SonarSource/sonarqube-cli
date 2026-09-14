export type SyntheticAnalyzer = 'sonar-secrets' | 'sqaa' | 'sca-scanner-cli';
export type SyntheticTrigger = 'hooks' | 'manual';

export interface SyntheticStatsEvent {
  id: number;
  timestampMs: number;
  analyzer: SyntheticAnalyzer;
  callerCommand: string;
  exitCode: number | null;
  callerAgent: string;
  runTrigger: SyntheticTrigger;
  durationMs: number;
  findingsCount: number;
  ruleCounts: Record<string, number>;
}
