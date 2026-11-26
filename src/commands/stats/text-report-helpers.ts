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
import { bold, dim, softBlue } from '@/core/ui/colors.ts';
import type { Console } from '@/core/ui/console.ts';
import { columnFormatting } from '@/core/ui/formatter/column-formatting.ts';

import type {
  PopulatedStatsViewModel,
  StatsMetric,
  StatsMetricRow,
  StatsUnavailable,
} from './view-model/index.ts';

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

export const BAR_WIDTH = 18;
const BAR_FILLED = '▓';
const BAR_EMPTY = '░';
const PERCENT_MULTIPLIER = 100;

export function bar(percent: number): string {
  const filled = Math.round(Math.min(Math.max(percent / PERCENT_MULTIPLIER, 0), 1) * BAR_WIDTH);
  return softBlue(BAR_FILLED.repeat(filled)) + dim(BAR_EMPTY.repeat(BAR_WIDTH - filled));
}

const CARD_METRIC_LABELS: Record<StatsMetric, string> = {
  runs: 'Analyses run',
  findings: 'Issues caught',
  'secrets-blocked': 'Secrets blocked',
  'dependency-risks': 'Dependency risks',
};
interface StatsPlaceholderRow {
  label: string;
  message: string;
  ctaUrl?: string;
}

const PLACEHOLDER_ROWS: Record<StatsUnavailable, StatsPlaceholderRow> = {
  'vortex-analysis': {
    label: 'vortex analysis',
    message: 'not available on this plan',
    ctaUrl: VORTEX_PRODUCT_URL,
  },
  'dependency-risks': { label: 'dependency risks', message: 'not enabled for this organization' },
};

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

const HEADER_COLUMN_GAP_WIDTH = 12;

export function printSummaryCard(summary: PopulatedStatsViewModel, console: Console): void {
  const { window, card } = summary;
  const { bucketDays, metrics: metricRows } = card;
  const columnLabel = bucketDays === 1 ? 'day' : `${bucketDays} days`;
  const placeholderRows = card.unavailable.map((key) => PLACEHOLDER_ROWS[key]);
  const [labelWidth] = columnFormatting([
    [
      ...metricRows.map((row) => CARD_METRIC_LABELS[row.metric]),
      ...placeholderRows.map((row) => row.label),
    ],
  ]);
  const [numberWidth] = columnFormatting([metricRows.map((row) => String(row.windowValue))]);

  if (window.since === 'all') {
    console.note([
      `◆ sonar stats · since ${formatDate(card.startedAtMs)}`,
      `                one column per ${columnLabel}`,
      '',
      ...metricRows.map(
        (row) =>
          `${CARD_METRIC_LABELS[row.metric].padEnd(labelWidth)}  ${String(row.windowValue).padStart(numberWidth)}  ${sparkline(row.series)}`,
      ),
      ...placeholderRows.flatMap((row) => formatPlaceholderLines(row, labelWidth)),
    ]);
    return;
  }

  const windowDaysLabel = `last ${window.days} days`;
  const ALL_TIME_LABEL = 'all time';

  const allTimeFormatted = metricRows.map((row) => row.allTimeValue.toLocaleString('en-US'));
  const [allTimeWidth] = columnFormatting([[ALL_TIME_LABEL, ...allTimeFormatted]]);

  const secondLinePrefix = `${windowDaysLabel} · one column per ${columnLabel}`;
  const secondLineIndent = ' '.repeat(labelWidth);
  const columnsShown = card.columnCount;

  const rowPrefixVisibleLength = labelWidth + 2 + numberWidth + 2 + columnsShown;
  const header2PrefixVisibleLength = labelWidth + secondLinePrefix.length;
  const allTimeColumnStart =
    Math.max(rowPrefixVisibleLength, header2PrefixVisibleLength) + HEADER_COLUMN_GAP_WIDTH;

  function metricLine(row: StatsMetricRow, allTimeFormattedValue: string): string {
    const gap = allTimeColumnStart - rowPrefixVisibleLength;
    return `${CARD_METRIC_LABELS[row.metric].padEnd(labelWidth)}  ${String(row.windowValue).padStart(numberWidth)}  ${sparkline(row.series)}${' '.repeat(gap)}${allTimeFormattedValue.padStart(allTimeWidth)}`;
  }

  const header2Gap = allTimeColumnStart - header2PrefixVisibleLength;
  console.note([
    `◆ sonar stats · since ${formatDate(card.startedAtMs)}`,
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
