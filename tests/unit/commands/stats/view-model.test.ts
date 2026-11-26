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

import { describe, expect, it } from 'bun:test';

import { buildStatsViewModel } from '@/commands/stats/view-model/build.ts';
import type { StatsSummary } from '@/core/stats/stats-queries.ts';

const ENTITLED = { vortex: 'enabled', sca: 'enabled' } as const;

const summary: StatsSummary = {
  sinceMs: 0,
  firstSeenMs: Date.UTC(2026, 0, 1),
  totalRuns: 3,
  totalFindings: 6,
  allTime: {
    totalRuns: 1234,
    totalFindings: 5678,
    secretsBlockedTotal: 9,
    dependencyRisksTotal: 10,
  },
  analyzers: [
    { analyzer: 'sca-scanner-cli', runs: 1, findings: 2 },
    { analyzer: 'sonar-secrets', runs: 3, findings: 4 },
  ],
  stopped: [
    { point: 'commit', count: 1 },
    { point: 'push', count: 2 },
  ],
  topSecretTypes: [{ label: 'fixture', count: 3 }],
  agentHitRate: { runsWithFindings: 2, totalRuns: 3 },
  agentBreakdown: [
    { agent: 'unidentified', runs: 2, findings: 3 },
    { agent: 'codex', runs: 1, findings: 2 },
  ],
  callerCommandBreakdown: [{ command: 'analyze secrets', runs: 2 }],
  triggers: [
    { trigger: 'hooks', runs: 2 },
    { trigger: 'manual', runs: 1 },
  ],
  topRules: [
    {
      ruleKey: 'rule',
      count: 2,
      message: 'A long message that must be wrapped into two lines for this fixture',
    },
  ],
  daily: [
    { dayEpoch: 20454, runs: 1, findings: 2 },
    { dayEpoch: 20455, runs: 2, findings: 4 },
  ],
  dailySecretsBlocked: [
    { dayEpoch: 20454, count: 0 },
    { dayEpoch: 20455, count: 1 },
  ],
  dailyDependencyRisks: [
    { dayEpoch: 20454, count: 0 },
    { dayEpoch: 20455, count: 2 },
  ],
};

const NO_OPTIONAL_SECTIONS: Partial<StatsSummary> = {
  analyzers: [],
  stopped: [],
  agentBreakdown: [],
  callerCommandBreakdown: [],
  topRules: [],
  triggers: [],
};

function runsMetric(model: ReturnType<typeof buildStatsViewModel>) {
  return model.card.metrics.find((row) => row.metric === 'runs');
}

describe('buildStatsViewModel', () => {
  it('derives ordered sections and percentages', () => {
    const model = buildStatsViewModel(summary, '7d', ENTITLED);

    expect(model.analyzers).toEqual({
      total: 4,
      rows: [
        { analyzer: 'sonar-secrets', runs: 3 },
        { analyzer: 'sca-scanner-cli', runs: 1 },
      ],
    });
    expect(model.stopped).toEqual({
      total: 3,
      entries: [
        { point: 'commit', count: 1 },
        { point: 'push', count: 2 },
      ],
      topSecretTypes: [{ label: 'fixture', count: 3 }],
    });
    expect(model.agents).toEqual({
      total: 5,
      rows: [
        { agent: 'unidentified', findings: 3, sharePercent: 60 },
        { agent: 'codex', findings: 2, sharePercent: 40 },
      ],
      hitPercent: 67,
      hasUnidentified: true,
    });
    expect(model.callerCommands).toEqual({
      total: 2,
      rows: [{ command: 'analyze secrets', runs: 2 }],
    });
    expect(model.triggers).toEqual({ hooksPercent: 67, manualPercent: 33 });
    expect(model.topRules).toEqual(summary.topRules);
  });

  it('builds the selected-window card', () => {
    const model = buildStatsViewModel(summary, '7d', ENTITLED);

    expect(model.window).toEqual({ since: '7d', days: 7 });
    expect(model.card).toEqual({
      startedAtMs: Date.UTC(2026, 0, 1),
      bucketDays: 1,
      metrics: [
        { metric: 'runs', windowValue: 3, allTimeValue: 1234, series: [1, 2] },
        { metric: 'findings', windowValue: 6, allTimeValue: 5678, series: [2, 4] },
        { metric: 'secrets-blocked', windowValue: 3, allTimeValue: 9, series: [0, 1] },
        { metric: 'dependency-risks', windowValue: 2, allTimeValue: 10, series: [0, 2] },
      ],
      unavailable: [],
    });
  });

  it('sums long daily series into buckets of several days', () => {
    const daily = Array.from({ length: 62 }, (_, index) => ({
      dayEpoch: 20454 + index,
      runs: 1,
      findings: 0,
    }));

    const model = buildStatsViewModel({ ...summary, daily }, 'all', ENTITLED);

    expect(model.card.bucketDays).toBe(3);
    expect(runsMetric(model)?.series).toEqual([...Array(20).fill(3), 2]);
  });

  it('uses the all-time blocked total and omits unavailable metrics in a stable order', () => {
    const model = buildStatsViewModel(summary, 'all', {
      vortex: 'not_entitled',
      sca: 'not_enabled',
    });

    expect(model.window).toEqual({ since: 'all' });
    expect(model.card.metrics.map((row) => row.metric)).toEqual([
      'runs',
      'findings',
      'secrets-blocked',
    ]);
    expect(model.card.metrics.find((row) => row.metric === 'secrets-blocked')?.windowValue).toBe(9);
    expect(model.card.unavailable).toEqual(['vortex-analysis', 'dependency-risks']);
  });

  it('marks absent sections as null', () => {
    const model = buildStatsViewModel({ ...summary, ...NO_OPTIONAL_SECTIONS }, '30d', {
      vortex: 'check_failed',
      sca: 'check_failed',
    });

    expect([
      model.analyzers,
      model.stopped,
      model.agents,
      model.callerCommands,
      model.topRules,
      model.triggers,
    ]).toEqual([null, null, null, null, null, null]);
  });

  it('reports zero shares when the denominators are zero', () => {
    const model = buildStatsViewModel(
      {
        ...summary,
        agentBreakdown: [{ agent: 'codex', findings: 0, runs: 0 }],
        agentHitRate: { totalRuns: 0, runsWithFindings: 0 },
      },
      '30d',
      ENTITLED,
    );

    expect(model.agents).toEqual({
      total: 0,
      rows: [{ agent: 'codex', findings: 0, sharePercent: 0 }],
      hitPercent: 0,
      hasUnidentified: false,
    });
  });
});
