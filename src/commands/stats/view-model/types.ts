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

import type {
  StatsCallerCommandRuns,
  StatsSecretTypeBreakdown,
  StatsSinceChoice,
  StatsStoppedBreakdown,
  StatsTopRule,
} from '@/core/stats/stats-queries.ts';

import type { StatsEntitlement } from '../entitlement.ts';

export const UNIDENTIFIED_AGENT_LABEL = 'unidentified';

export type StatsWindow =
  { since: 'all' } | { since: Exclude<StatsSinceChoice, 'all'>; days: number };

export type StatsMetric = 'runs' | 'findings' | 'secrets-blocked' | 'dependency-risks';

export type StatsUnavailable = 'vortex-analysis' | 'dependency-risks';

export interface StatsMetricRow {
  metric: StatsMetric;
  windowValue: number;
  allTimeValue: number;
  series: number[];
}

export interface StatsCardViewModel {
  startedAtMs: number;
  bucketDays: number;
  metrics: StatsMetricRow[];
  unavailable: StatsUnavailable[];
}

export interface StatsTotaledRows<T> {
  total: number;
  rows: T[];
}

export interface StatsAnalyzerRow {
  analyzer: string;
  runs: number;
}

export type StatsAnalyzersViewModel = StatsTotaledRows<StatsAnalyzerRow>;

export interface StatsStoppedViewModel {
  total: number;
  entries: StatsStoppedBreakdown[];
  topSecretTypes: StatsSecretTypeBreakdown[];
}

export interface StatsAgentRow {
  agent: string;
  findings: number;
  sharePercent: number;
}

export interface StatsAgentsViewModel extends StatsTotaledRows<StatsAgentRow> {
  hitPercent: number | null;
  hasUnidentified: boolean;
}

export type StatsCallerCommandsViewModel = StatsTotaledRows<StatsCallerCommandRuns>;

export interface StatsTriggersViewModel {
  hooksPercent: number;
  manualPercent: number;
}

export interface PopulatedStatsViewModel {
  hasHistory: true;
  window: StatsWindow;
  entitlement: StatsEntitlement;
  card: StatsCardViewModel;
  analyzers: StatsAnalyzersViewModel | null;
  stopped: StatsStoppedViewModel | null;
  agents: StatsAgentsViewModel | null;
  callerCommands: StatsCallerCommandsViewModel | null;
  topRules: StatsTopRule[] | null;
  triggers: StatsTriggersViewModel | null;
}

export interface EmptyStatsViewModel {
  hasHistory: false;
}

export type StatsViewModel = EmptyStatsViewModel | PopulatedStatsViewModel;

export const EMPTY_STATS_VIEW_MODEL: EmptyStatsViewModel = { hasHistory: false };
