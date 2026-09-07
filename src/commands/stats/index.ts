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

import { resolveAuth } from '@/core/auth/auth-resolver.ts';
import { VORTEX_PRODUCT_URL } from '@/core/config-constants.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import {
  queryStatsSummary,
  type StatsStoppedBreakdown,
  type StatsStopPoint,
  type StatsSummary,
} from '@/core/stats/stats-queries.ts';
import { blank, bold, dim, note, print } from '@/core/ui';
import { lavender } from '@/core/ui/colors.ts';
import { columnFormatting } from '@/core/ui/formatter/column-formatting.ts';
import { resolveVortexEntitlement } from '@/core/vortex/entitlement.ts';

export const STATS_SINCE_CHOICES = ['7d', '14d', '30d', 'all'] as const;
export type StatsSinceChoice = (typeof STATS_SINCE_CHOICES)[number];

export interface StatsOptions {
  since?: StatsSinceChoice;
  json?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveSinceMs(since: StatsSinceChoice): number {
  if (since === 'all') return 0;
  const days = Number.parseInt(since, 10);
  const todayStartMs = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  return todayStartMs - (days - 1) * DAY_MS;
}

export interface StatsEntitlement {
  vortexNotEntitled: boolean;
  scaNotEnabled: boolean;
}

async function resolveStatsEntitlement(): Promise<StatsEntitlement> {
  const auth = await resolveAuth({ silent: true }).catch(() => null);
  if (!auth) {
    return { vortexNotEntitled: false, scaNotEnabled: false };
  }

  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  const [vortex, sca] = await Promise.all([
    resolveVortexEntitlement(auth),
    client.getScaEnablement(auth.connectionType, auth.orgKey).catch(() => 'check_failed' as const),
  ]);

  return {
    vortexNotEntitled: vortex.status === 'not_entitled',
    scaNotEnabled: sca === 'not_enabled',
  };
}

export async function sonarStats(options: StatsOptions): Promise<void> {
  const since = options.since ?? '30d';
  const summary = queryStatsSummary(resolveSinceMs(since));

  if (options.json) {
    const entitlement = summary.totalRuns > 0 ? await resolveStatsEntitlement() : null;
    print(JSON.stringify({ ...summary, entitlement }, null, 2));
    return;
  }

  await renderTextSummary(summary, since);
}

async function renderTextSummary(summary: StatsSummary, since: StatsSinceChoice): Promise<void> {
  if (summary.totalRuns === 0) {
    printEmptyState();
    return;
  }

  const entitlement = await resolveStatsEntitlement();

  printSummaryCard(summary, since, entitlement);
  printAnalyzerBreakdownSection(summary);
  printStoppedSection(summary);
  printAgentBreakdownSection(summary);
  printCallerCommandSection(summary);
  printTopRulesSection(summary);
  printTriggerLine(summary);
}

function printEmptyState(): void {
  print(`${bold('◆ sonar stats')} ${dim('· nothing recorded yet · this machine')}`);
  blank();
  print(dim('  stats shows what the CLI catches while you work.'));
  print(dim('  Install the hooks and it starts counting from your next commit.'));
  blank();
  print(`  ${dim('→ Install them:')} ${lavender('sonar integrate')}`);
}

const SPARKLINE_BLOCKS = '▁▂▃▄▅▆▇█';
const SPARKLINE_MAX_LEVEL = SPARKLINE_BLOCKS.length - 2;

function sparkline(values: readonly number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  if (max === 0) return lavender(SPARKLINE_BLOCKS[0].repeat(values.length));
  const line = values
    .map((v) => SPARKLINE_BLOCKS[Math.round((v / max) * SPARKLINE_MAX_LEVEL)])
    .join('');
  return lavender(line);
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

const BAR_WIDTH = 18;
const BAR_FILLED = '▓';
const BAR_EMPTY = '░';

function bar(fraction: number): string {
  const filled = Math.round(Math.min(Math.max(fraction, 0), 1) * BAR_WIDTH);
  return lavender(BAR_FILLED.repeat(filled)) + dim(BAR_EMPTY.repeat(BAR_WIDTH - filled));
}

const PERCENT_MULTIPLIER = 100;
const SHARE_PERCENT_WIDTH = 3;

function percentOf(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * PERCENT_MULTIPLIER) : 0;
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
  if (entitlement.vortexNotEntitled) {
    rows.push({
      label: VORTEX_NOT_ENTITLED_LABEL,
      message: VORTEX_NOT_ENTITLED_MESSAGE,
      ctaUrl: VORTEX_PRODUCT_URL,
    });
  }
  if (entitlement.scaNotEnabled) {
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
  const base = `${row.label.padEnd(labelWidth)}  ${dim('—')}  ${dim(row.message)}`;
  if (!row.ctaUrl) return [base];
  // The note() box truncates any single line past its max width — a label + message + URL
  // on one line can exceed that, so the CTA gets its own (short, fixed-indent) line instead
  // of risking truncation.
  const ctaLabel = dim(`→ ${PLACEHOLDER_CTA_ACTION}`);
  return [base, `${PLACEHOLDER_CTA_INDENT}${ctaLabel} ${lavender(row.ctaUrl)}`];
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

function printSummaryCard(
  summary: StatsSummary,
  since: StatsSinceChoice,
  entitlement: StatsEntitlement,
): void {
  const secretsBlockedTotal = summary.stopped.reduce((sum, entry) => sum + entry.count, 0);
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
    ...(entitlement.scaNotEnabled
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
    note([
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
  note([
    `◆ sonar stats · since ${formatDate(summary.firstSeenMs ?? Date.now())}`,
    `${secondLineIndent}${secondLinePrefix}${' '.repeat(header2Gap)}${ALL_TIME_LABEL.padStart(allTimeWidth)}`,
    '',
    ...metricRows.map((row, i) => metricLine(row, allTimeFormatted[i])),
    ...placeholderRows.flatMap((row) => formatPlaceholderLines(row, labelWidth)),
  ]);
}

const MIN_HEADING_GAP_WIDTH = 2;
const ANALYZER_DISPLAY_LABELS: Partial<Record<string, string>> = {
  'sonar-secrets': 'secrets',
  sqaa: 'vortex analysis',
  'sca-scanner-cli': 'dependency risks',
};

function analyzerDisplayLabel(analyzer: string): string {
  return ANALYZER_DISPLAY_LABELS[analyzer] ?? analyzer;
}

const BASE_COLUMN_GAP_WIDTH = 3;

interface AlignedTotalsLayout {
  headingLine: string;
  rowGap: string;
}

// When the heading text is longer than the data columns below it (e.g. "Analyses run by
// scanner" with only a handful of short analyzer names), the row's own last-number gap is
// widened so the header's total and the row values still end at the same column — mirroring
// how printSummaryCard aligns its "all time" column.
function computeAlignedTotalsLayout(
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

function printAnalyzerBreakdownSection(summary: StatsSummary): void {
  if (summary.analyzers.length === 0) return;

  const totalRuns = summary.analyzers.reduce((sum, a) => sum + a.runs, 0);
  const sorted = [...summary.analyzers].sort((a, b) => b.runs - a.runs);

  const [labelWidth] = columnFormatting([[...sorted.map((a) => analyzerDisplayLabel(a.analyzer))]]);
  const [runsWidth] = columnFormatting([[...sorted.map((a) => String(a.runs))]]);
  const naturalRowEndColumn = 4 + labelWidth + BASE_COLUMN_GAP_WIDTH + runsWidth;
  const { headingLine, rowGap } = computeAlignedTotalsLayout(
    'Analyses run by scanner',
    totalRuns,
    naturalRowEndColumn,
  );

  blank();
  print(headingLine);
  for (const a of sorted) {
    print(
      `    ${analyzerDisplayLabel(a.analyzer).padEnd(labelWidth)}${rowGap}${String(a.runs).padStart(runsWidth)}`,
    );
  }
}

const STOP_POINT_ORDER: readonly StatsStopPoint[] = ['commit', 'prompt', 'file-read', 'push'];

const STOP_POINT_COPY: Record<StatsStopPoint, { label: string; detail: string }> = {
  commit: { label: 'at commit', detail: 'secrets in staged files' },
  prompt: { label: 'at a prompt', detail: 'secrets in prompt text' },
  'file-read': { label: 'at a file read', detail: 'an agent tried to read it' },
  push: { label: 'at push', detail: 'secrets in unpushed commits' },
};

function orderStoppedEntries(entries: readonly StatsStoppedBreakdown[]): StatsStoppedBreakdown[] {
  const byPoint = new Map(entries.map((entry) => [entry.point, entry]));
  return STOP_POINT_ORDER.map((point) => byPoint.get(point)).filter(
    (entry): entry is StatsStoppedBreakdown => entry !== undefined,
  );
}

function printStoppedSection(summary: StatsSummary): void {
  if (summary.stopped.length === 0) return;
  const ordered = orderStoppedEntries(summary.stopped);
  const total = ordered.reduce((sum, entry) => sum + entry.count, 0);

  blank();
  print(bold(`Secrets blocked · ${total} total`));

  const [pointWidth] = columnFormatting([
    [...ordered.map((entry) => STOP_POINT_COPY[entry.point].label)],
  ]);
  const [countWidth] = columnFormatting([[...ordered.map((entry) => String(entry.count))]]);

  for (const entry of ordered) {
    const { label, detail } = STOP_POINT_COPY[entry.point];
    print(
      `    ${label.padEnd(pointWidth)}   ${String(entry.count).padStart(countWidth)}   ${detail}`,
    );
  }

  if (summary.topSecretTypes.length > 0) {
    const line = summary.topSecretTypes.map((t) => `${t.count} ${t.label}`).join(' · ');
    print(`    ${line}`);
  }
}

const SHARE_BAR_GAP = '  ';
const UNIDENTIFIED_AGENT_LABEL = 'unidentified';
const NO_AGENT_DISPLAY_LABEL = 'no agent';
const NO_AGENT_EXPLANATION = 'no agent: run manually, via a script, or by an unrecognized agent';

function agentDisplayLabel(agent: string): string {
  return agent === UNIDENTIFIED_AGENT_LABEL ? NO_AGENT_DISPLAY_LABEL : agent;
}

function printAgentBreakdownSection(summary: StatsSummary): void {
  if (summary.agentBreakdown.length === 0) return;

  const totalFindings = summary.agentBreakdown.reduce((sum, agent) => sum + agent.findings, 0);

  const [agentWidth] = columnFormatting([
    [...summary.agentBreakdown.map((agent) => agentDisplayLabel(agent.agent))],
  ]);
  const [issuesWidth] = columnFormatting([
    [...summary.agentBreakdown.map((agent) => String(agent.findings))],
  ]);
  const percentWidth = SHARE_PERCENT_WIDTH + 1;
  const naturalRowEndColumn =
    4 +
    agentWidth +
    BASE_COLUMN_GAP_WIDTH +
    BAR_WIDTH +
    SHARE_BAR_GAP.length +
    percentWidth +
    BASE_COLUMN_GAP_WIDTH +
    issuesWidth;
  const { headingLine, rowGap } = computeAlignedTotalsLayout(
    'Issues by agent',
    totalFindings,
    naturalRowEndColumn,
  );

  blank();
  print(headingLine);

  for (const agent of summary.agentBreakdown) {
    const share = percentOf(agent.findings, totalFindings);
    const percentCell = `${share}%`.padStart(percentWidth);
    print(
      `    ${agentDisplayLabel(agent.agent).padEnd(agentWidth)}   ${bar(share / PERCENT_MULTIPLIER)}${SHARE_BAR_GAP}${percentCell}${rowGap}${String(agent.findings).padStart(issuesWidth)}`,
    );
  }

  if (summary.agentHitRate) {
    const hitPercent = percentOf(
      summary.agentHitRate.runsWithFindings,
      summary.agentHitRate.totalRuns,
    );
    print(`    ${hitPercent}% of agent runs surfaced an issue`);
  }

  if (summary.agentBreakdown.some((agent) => agent.agent === UNIDENTIFIED_AGENT_LABEL)) {
    print(dim(`    ${NO_AGENT_EXPLANATION}`));
  }
}

function printCallerCommandSection(summary: StatsSummary): void {
  if (summary.callerCommandBreakdown.length === 0) return;

  const totalRuns = summary.callerCommandBreakdown.reduce((sum, c) => sum + c.runs, 0);

  const [commandWidth] = columnFormatting([
    [...summary.callerCommandBreakdown.map((c) => c.command)],
  ]);
  const [runsWidth] = columnFormatting([
    [...summary.callerCommandBreakdown.map((c) => String(c.runs))],
  ]);
  const naturalRowEndColumn = 4 + commandWidth + BASE_COLUMN_GAP_WIDTH + runsWidth;
  const { headingLine, rowGap } = computeAlignedTotalsLayout(
    'Runs by command',
    totalRuns,
    naturalRowEndColumn,
  );

  blank();
  print(headingLine);
  for (const c of summary.callerCommandBreakdown) {
    print(`    ${c.command.padEnd(commandWidth)}${rowGap}${String(c.runs).padStart(runsWidth)}`);
  }
}

const MAX_MESSAGE_LINE_LENGTH = 42;
const WRAP_CONTINUATION_EXTRA_INDENT = '  ';

function wrapMessage(message: string): [string, string | null] {
  if (message.length <= MAX_MESSAGE_LINE_LENGTH) return [message, null];
  const lastSpace = message.lastIndexOf(' ', MAX_MESSAGE_LINE_LENGTH);
  const breakAt = lastSpace > 0 ? lastSpace : MAX_MESSAGE_LINE_LENGTH;
  return [message.slice(0, breakAt), message.slice(breakAt + 1)];
}

function printTopRulesSection(summary: StatsSummary): void {
  if (summary.topRules.length === 0) return;
  blank();
  print(bold('You keep hitting these issues'));

  const wrapped = summary.topRules.map((rule) => wrapMessage(rule.message ?? ''));
  const [ruleWidth] = columnFormatting([[...summary.topRules.map((rule) => rule.ruleKey)]]);
  const [countWidth] = columnFormatting([[...summary.topRules.map((rule) => String(rule.count))]]);

  summary.topRules.forEach((rule, i) => {
    const [firstLine, continuation] = wrapped[i];
    print(
      `    ${firstLine.padEnd(MAX_MESSAGE_LINE_LENGTH)}   ${rule.ruleKey.padEnd(ruleWidth)}   ${String(rule.count).padStart(countWidth)}`,
    );
    if (continuation) {
      print(`    ${WRAP_CONTINUATION_EXTRA_INDENT}${continuation}`);
    }
  });
}

function printTriggerLine(summary: StatsSummary): void {
  const hooksRuns = summary.triggers.find((t) => t.trigger === 'hooks')?.runs ?? 0;
  const manualRuns = summary.triggers.find((t) => t.trigger === 'manual')?.runs ?? 0;
  const total = hooksRuns + manualRuns;
  if (total === 0) return;

  blank();
  print(
    `    ${percentOf(hooksRuns, total)}% ran from hooks  ·  ${percentOf(manualRuns, total)}% ran directly`,
  );
}
