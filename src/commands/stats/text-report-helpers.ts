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

import { VORTEX_PRODUCT_URL } from '@/core/config-constants.ts';
import type { StatsSinceChoice, StatsSummary } from '@/core/stats/stats-queries.ts';
import { bold, dim, softBlue } from '@/core/ui/colors.ts';
import type { Console } from '@/core/ui/console.ts';
import { columnFormatting } from '@/core/ui/formatter/column-formatting.ts';

import type { StatsEntitlement } from './entitlement.ts';

const SPARKLINE_BLOCKS = '▁▂▃▄▅▆▇█';
const SPARKLINE_MAX_LEVEL = SPARKLINE_BLOCKS.length - 2;

export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  if (max === 0) return softBlue(SPARKLINE_BLOCKS[0].repeat(values.length));
  const line = values
    .map((v) => SPARKLINE_BLOCKS[Math.round((v / max) * SPARKLINE_MAX_LEVEL)])
    .join('');
  return softBlue(line);
}

const MAX_SPARKLINE_COLUMNS = 30;

function resolveBucketDays(totalDays: number): number {
  return totalDays > MAX_SPARKLINE_COLUMNS ? Math.ceil(totalDays / MAX_SPARKLINE_COLUMNS) : 1;
}

function downsampleSum(values: readonly number[], bucketDays: number): number[] {
  if (bucketDays <= 1) return [...values];
  const buckets: number[] = [];
  for (let i = 0; i < values.length; i += bucketDays) {
    buckets.push(values.slice(i, i + bucketDays).reduce((sum, v) => sum + v, 0));
  }
  return buckets;
}

export const BAR_WIDTH = 18;
const BAR_FILLED = '▓';
const BAR_EMPTY = '░';

export function bar(fraction: number): string {
  const filled = Math.round(Math.min(Math.max(fraction, 0), 1) * BAR_WIDTH);
  return softBlue(BAR_FILLED.repeat(filled)) + dim(BAR_EMPTY.repeat(BAR_WIDTH - filled));
}

const CARD_METRIC_LABELS = ['Analyses run', 'Issues caught'] as const;
const CARD_TOTAL_LABELS = ['Secrets blocked', 'Dependency risks'] as const;

const VORTEX_NOT_ENTITLED_LABEL = 'vortex analysis';
const VORTEX_NOT_ENTITLED_MESSAGE = 'not available on this plan';
const DEPENDENCY_RISKS_NOT_ENABLED_LABEL = 'dependency risks';
const DEPENDENCY_RISKS_NOT_ENABLED_MESSAGE = 'not enabled for this organization';

interface StatsMetricRow {
  label: string;
  windowValue: number;
  dailySeries: readonly number[];
  allTimeValue: number;
}

interface StatsPlaceholderRow {
  label: string;
  message: string;
  ctaUrl?: string;
}

function buildPlaceholderRows(entitlement: StatsEntitlement): StatsPlaceholderRow[] {
  const rows: StatsPlaceholderRow[] = [];
  if (entitlement.vortex === 'not_entitled') {
    rows.push({
      label: VORTEX_NOT_ENTITLED_LABEL,
      message: VORTEX_NOT_ENTITLED_MESSAGE,
      ctaUrl: VORTEX_PRODUCT_URL,
    });
  }
  if (entitlement.sca === 'not_enabled') {
    rows.push({
      label: DEPENDENCY_RISKS_NOT_ENABLED_LABEL,
      message: DEPENDENCY_RISKS_NOT_ENABLED_MESSAGE,
    });
  }
  return rows;
}

const PLACEHOLDER_CTA_INDENT = '  ';
const PLACEHOLDER_CTA_ACTION = 'Learn more:';

function formatPlaceholderLines(row: StatsPlaceholderRow, labelWidth: number): string[] {
  const base = `${row.label.padEnd(labelWidth)}  ${dim('-')}  ${dim(row.message)}`;
  if (!row.ctaUrl) return [base];
  const ctaLabel = dim(`→ ${PLACEHOLDER_CTA_ACTION}`);
  return [base, `${PLACEHOLDER_CTA_INDENT}${ctaLabel} ${softBlue(row.ctaUrl)}`];
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const SINCE_WINDOW_DAYS: Record<Exclude<StatsSinceChoice, 'all'>, number> = {
  '7d': 7,
  '14d': 14,
  '30d': 30,
};

const HEADER_COLUMN_GAP_WIDTH = 12;

export function printSummaryCard(
  summary: StatsSummary,
  since: StatsSinceChoice,
  entitlement: StatsEntitlement,
  console: Console,
): void {
  const secretsBlockedTotal =
    since === 'all'
      ? summary.allTime.secretsBlockedTotal
      : summary.stopped.reduce((sum, entry) => sum + entry.count, 0);
  const dependencyRisksTotal =
    summary.analyzers.find((a) => a.analyzer === 'sca-scanner-cli')?.findings ?? 0;

  const dailyRuns = summary.daily.map((d) => d.runs);
  const dailyFindings = summary.daily.map((d) => d.findings);
  const dailySecretsBlocked = summary.dailySecretsBlocked.map((d) => d.count);
  const dailyDependencyRisks = summary.dailyDependencyRisks.map((d) => d.count);

  const bucketDays = resolveBucketDays(dailyRuns.length);
  const columnLabel = bucketDays === 1 ? 'day' : `${bucketDays} days`;

  const metricRows: StatsMetricRow[] = [
    {
      label: CARD_METRIC_LABELS[0],
      windowValue: summary.totalRuns,
      dailySeries: dailyRuns,
      allTimeValue: summary.allTime.totalRuns,
    },
    {
      label: CARD_METRIC_LABELS[1],
      windowValue: summary.totalFindings,
      dailySeries: dailyFindings,
      allTimeValue: summary.allTime.totalFindings,
    },
    {
      label: CARD_TOTAL_LABELS[0],
      windowValue: secretsBlockedTotal,
      dailySeries: dailySecretsBlocked,
      allTimeValue: summary.allTime.secretsBlockedTotal,
    },
    ...(entitlement.sca === 'not_enabled'
      ? []
      : [
          {
            label: CARD_TOTAL_LABELS[1],
            windowValue: dependencyRisksTotal,
            dailySeries: dailyDependencyRisks,
            allTimeValue: summary.allTime.dependencyRisksTotal,
          },
        ]),
  ];
  const placeholderRows = buildPlaceholderRows(entitlement);

  const [labelWidth] = columnFormatting([
    [...metricRows.map((row) => row.label), ...placeholderRows.map((row) => row.label)],
  ]);
  const [numberWidth] = columnFormatting([metricRows.map((row) => String(row.windowValue))]);

  if (since === 'all') {
    console.note([
      `◆ sonar stats · since ${formatDate(summary.firstSeenMs ?? Date.now())}`,
      `                one column per ${columnLabel}`,
      '',
      ...metricRows.map(
        (row) =>
          `${row.label.padEnd(labelWidth)}  ${String(row.windowValue).padStart(numberWidth)}  ${sparkline(downsampleSum(row.dailySeries, bucketDays))}`,
      ),
      ...placeholderRows.flatMap((row) => formatPlaceholderLines(row, labelWidth)),
    ]);
    return;
  }

  const windowDaysLabel = `last ${SINCE_WINDOW_DAYS[since]} days`;
  const ALL_TIME_LABEL = 'all time';

  const allTimeFormatted = metricRows.map((row) => row.allTimeValue.toLocaleString('en-US'));
  const [allTimeWidth] = columnFormatting([[ALL_TIME_LABEL, ...allTimeFormatted]]);

  const secondLinePrefix = `${windowDaysLabel} · one column per ${columnLabel}`;
  const secondLineIndent = ' '.repeat(labelWidth);
  const columnsShown = Math.ceil(dailyRuns.length / bucketDays);

  const rowPrefixVisibleLength = labelWidth + 2 + numberWidth + 2 + columnsShown;
  const header2PrefixVisibleLength = labelWidth + secondLinePrefix.length;
  const allTimeColumnStart =
    Math.max(rowPrefixVisibleLength, header2PrefixVisibleLength) + HEADER_COLUMN_GAP_WIDTH;

  function metricLine(row: StatsMetricRow, allTimeFormattedValue: string): string {
    const gap = allTimeColumnStart - rowPrefixVisibleLength;
    return `${row.label.padEnd(labelWidth)}  ${String(row.windowValue).padStart(numberWidth)}  ${sparkline(downsampleSum(row.dailySeries, bucketDays))}${' '.repeat(gap)}${allTimeFormattedValue.padStart(allTimeWidth)}`;
  }

  const header2Gap = allTimeColumnStart - header2PrefixVisibleLength;
  console.note([
    `◆ sonar stats · since ${formatDate(summary.firstSeenMs ?? Date.now())}`,
    `${secondLineIndent}${secondLinePrefix}${' '.repeat(header2Gap)}${ALL_TIME_LABEL.padStart(allTimeWidth)}`,
    '',
    ...metricRows.map((row, i) => metricLine(row, allTimeFormatted[i])),
    ...placeholderRows.flatMap((row) => formatPlaceholderLines(row, labelWidth)),
  ]);
}

const MIN_HEADING_GAP_WIDTH = 2;

export const BASE_COLUMN_GAP_WIDTH = 3;

interface AlignedTotalsLayout {
  headingLine: string;
  rowGap: string;
}

export function computeAlignedTotalsLayout(
  heading: string,
  totalCount: number,
  naturalRowEndColumn: number,
): AlignedTotalsLayout {
  const numberLabel = totalCount.toLocaleString('en-US');
  const desiredRowEndColumn = Math.max(
    naturalRowEndColumn,
    heading.length + MIN_HEADING_GAP_WIDTH + numberLabel.length,
  );
  const headingGapWidth = desiredRowEndColumn - heading.length - numberLabel.length;
  const rowGapWidth = BASE_COLUMN_GAP_WIDTH + (desiredRowEndColumn - naturalRowEndColumn);
  return {
    headingLine: `${bold(heading)}${' '.repeat(headingGapWidth)}${numberLabel} total`,
    rowGap: ' '.repeat(rowGapWidth),
  };
}
