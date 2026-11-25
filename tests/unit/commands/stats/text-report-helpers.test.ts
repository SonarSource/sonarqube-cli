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

import {
  bar,
  computeAlignedTotalsLayout,
  printSummaryCard,
  sparkline,
} from '@/commands/stats/text-report-helpers.ts';
import { buildStatsViewModel } from '@/commands/stats/view-model/index.ts';
import type { StatsSummary } from '@/core/stats/stats-queries.ts';
import { bold, dim, softBlue } from '@/core/ui/colors.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

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
  analyzers: [{ analyzer: 'sca-scanner-cli', runs: 1, findings: 2 }],
  stopped: [{ point: 'commit', count: 1 }],
  topSecretTypes: [],
  agentHitRate: null,
  agentBreakdown: [],
  callerCommandBreakdown: [],
  triggers: [],
  topRules: [],
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

describe('stats rendering helpers', () => {
  it('keeps sparkline levels, color and empty behavior', () => {
    expect(sparkline([])).toBe('');
    expect(sparkline([0, 0])).toBe(softBlue('▁▁'));
    expect(sparkline([0, 1, 2, 4])).toBe(softBlue('▁▃▄▇'));
  });
  it.each([-1, 0, 0.5, 1, 2])('clamps and rounds bar fraction %s', (fraction) => {
    const expected = fraction <= 0 ? [0, 18] : fraction >= 1 ? [18, 0] : [9, 9];
    expect(bar(fraction * 100)).toBe(
      softBlue('▓'.repeat(expected[0])) + dim('░'.repeat(expected[1])),
    );
  });
  it('aligns totals to natural rows or extends them for a long heading', () => {
    expect(computeAlignedTotalsLayout('Runs', 1234, 15)).toEqual({
      headingLine: `${bold('Runs')}      1,234 total`,
      rowGap: '   ',
    });
    expect(computeAlignedTotalsLayout('Analyses run by scanner', 1, 8)).toEqual({
      headingLine: `${bold('Analyses run by scanner')}  1 total`,
      rowGap: ' '.repeat(21),
    });
  });
  it.each(['7d', '14d', '30d', 'all'] as const)('preserves the %s summary card', (since) => {
    const console = new FakeConsole();
    printSummaryCard(
      buildStatsViewModel(summary, since, { vortex: 'enabled', sca: 'enabled' }),
      console,
    );
    expect(console.calls).toMatchSnapshot();
  });
  it('keeps unavailable-service placeholders and the learn-more line', () => {
    const console = new FakeConsole();
    printSummaryCard(
      buildStatsViewModel(summary, '30d', { vortex: 'not_entitled', sca: 'not_enabled' }),
      console,
    );
    expect(console.calls).toMatchSnapshot();
  });
  it('sums long daily series into at most thirty columns', () => {
    const console = new FakeConsole();
    const daily = Array.from({ length: 31 }, (_, index) => ({
      dayEpoch: 20454 + index,
      runs: 1,
      findings: 0,
    }));
    printSummaryCard(
      buildStatsViewModel({ ...summary, daily }, 'all', { vortex: 'enabled', sca: 'enabled' }),
      console,
    );
    expect(console.calls).toMatchSnapshot();
  });
});
