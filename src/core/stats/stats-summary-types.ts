/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

export type StatsSinceChoice = '7d' | '14d' | '30d' | 'all';
export type StatsStopPoint = 'commit' | 'push' | 'prompt' | 'file-read';

export interface StatsAnalyzerTotal {
  analyzer: string;
  runs: number;
  findings: number;
}
export interface StatsStoppedBreakdown {
  point: StatsStopPoint;
  count: number;
}
export interface StatsAgentHitRate {
  runsWithFindings: number;
  totalRuns: number;
}
export interface StatsAgentShare {
  agent: string;
  runs: number;
  findings: number;
}
export interface StatsTriggerShare {
  trigger: string;
  runs: number;
}
export interface StatsTopRule {
  ruleKey: string;
  count: number;
  message: string | null;
}
export interface StatsDailyPoint {
  dayEpoch: number;
  runs: number;
  findings: number;
}
export interface StatsDailyCount {
  dayEpoch: number;
  count: number;
}
export interface StatsAllTimeTotals {
  totalRuns: number;
  totalFindings: number;
  secretsBlockedTotal: number;
  dependencyRisksTotal: number;
}
export interface StatsSecretTypeBreakdown {
  label: string;
  count: number;
}
export interface StatsCallerCommandRuns {
  command: string;
  runs: number;
}

export interface StatsSummary {
  sinceMs: number;
  totalRuns: number;
  totalFindings: number;
  allTime: StatsAllTimeTotals;
  analyzers: StatsAnalyzerTotal[];
  stopped: StatsStoppedBreakdown[];
  topSecretTypes: StatsSecretTypeBreakdown[];
  agentHitRate: StatsAgentHitRate | null;
  agentBreakdown: StatsAgentShare[];
  callerCommandBreakdown: StatsCallerCommandRuns[];
  triggers: StatsTriggerShare[];
  topRules: StatsTopRule[];
  daily: StatsDailyPoint[];
  dailySecretsBlocked: StatsDailyCount[];
  dailyDependencyRisks: StatsDailyCount[];
  firstSeenMs: number | null;
}
