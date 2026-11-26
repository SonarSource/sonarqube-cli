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
  StatsCardViewModel,
  StatsMetric,
  StatsMetricRow,
  StatsUnavailable,
  StatsWindow,
} from './view-model/types.ts';

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
const MAX_PERCENT = 100;

export function bar(percent: number): string {
  const clamped = Math.min(Math.max(percent, 0), MAX_PERCENT);
  const filled = Math.round((clamped / MAX_PERCENT) * BAR_WIDTH);
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

const CARD_COLUMN_GAP = '  ';
const HEADER_COLUMN_GAP_WIDTH = 12;
const ALL_TIME_LABEL = 'all time';
const ALL_HISTORY_SUBTITLE_INDENT = ' '.repeat(16);

interface CardLayout {
  labelWidth: number;
  numberWidth: number;
  columnLabel: string;
}

export function printSummaryCard(
  window: StatsWindow,
  card: StatsCardViewModel,
  console: Console,
): void {
  const placeholderRows = card.unavailable.map((key) => PLACEHOLDER_ROWS[key]);
  const layout = resolveCardLayout(card, placeholderRows);
  const headerAndMetricLines =
    window.since === 'all'
      ? allHistoryCardLines(card, layout)
      : windowedCardLines(window.days, card, layout);

  console.note([
    ...headerAndMetricLines,
    ...placeholderRows.flatMap((row) => formatPlaceholderLines(row, layout.labelWidth)),
  ]);
}

function resolveCardLayout(
  card: StatsCardViewModel,
  placeholderRows: readonly StatsPlaceholderRow[],
): CardLayout {
  const labels = [...card.metrics.map(metricLabel), ...placeholderRows.map((row) => row.label)];
  const [labelWidth] = columnFormatting([labels]);
  const [numberWidth] = columnFormatting([card.metrics.map((row) => String(row.windowValue))]);
  return { labelWidth, numberWidth, columnLabel: formatColumnLabel(card.bucketDays) };
}

function formatColumnLabel(bucketDays: number): string {
  return bucketDays === 1 ? 'day' : `${bucketDays} days`;
}

function metricLabel(row: StatsMetricRow): string {
  return CARD_METRIC_LABELS[row.metric];
}

function cardTitle(card: StatsCardViewModel): string {
  return `◆ sonar stats · since ${formatDate(card.startedAtMs)}`;
}

function formatMetricPrefix(row: StatsMetricRow, layout: CardLayout): string {
  const label = metricLabel(row).padEnd(layout.labelWidth);
  const value = String(row.windowValue).padStart(layout.numberWidth);
  return `${label}${CARD_COLUMN_GAP}${value}${CARD_COLUMN_GAP}${sparkline(row.series)}`;
}

function allHistoryCardLines(card: StatsCardViewModel, layout: CardLayout): string[] {
  return [
    cardTitle(card),
    `${ALL_HISTORY_SUBTITLE_INDENT}one column per ${layout.columnLabel}`,
    '',
    ...card.metrics.map((row) => formatMetricPrefix(row, layout)),
  ];
}

function windowedCardLines(days: number, card: StatsCardViewModel, layout: CardLayout): string[] {
  const { labelWidth, numberWidth, columnLabel } = layout;
  const allTimeValues = card.metrics.map((row) => row.allTimeValue.toLocaleString('en-US'));
  const [allTimeWidth] = columnFormatting([[ALL_TIME_LABEL, ...allTimeValues]]);

  const subtitle = `last ${days} days · one column per ${columnLabel}`;
  const columnsShown = card.metrics[0].series.length;
  const rowPrefixLength =
    labelWidth + CARD_COLUMN_GAP.length + numberWidth + CARD_COLUMN_GAP.length + columnsShown;
  const subtitlePrefixLength = labelWidth + subtitle.length;
  const allTimeColumnStart =
    Math.max(rowPrefixLength, subtitlePrefixLength) + HEADER_COLUMN_GAP_WIDTH;
  const rowGap = ' '.repeat(allTimeColumnStart - rowPrefixLength);
  const subtitleGap = ' '.repeat(allTimeColumnStart - subtitlePrefixLength);

  function metricLine(row: StatsMetricRow, index: number): string {
    return `${formatMetricPrefix(row, layout)}${rowGap}${allTimeValues[index].padStart(allTimeWidth)}`;
  }

  return [
    cardTitle(card),
    `${' '.repeat(labelWidth)}${subtitle}${subtitleGap}${ALL_TIME_LABEL.padStart(allTimeWidth)}`,
    '',
    ...card.metrics.map((row, index) => metricLine(row, index)),
  ];
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
