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

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import type {
  StatsSinceChoice,
  StatsStoppedBreakdown,
  StatsStopPoint,
  StatsSummary,
} from '@/core/stats/stats-queries.ts';
import { bold, dim, softBlue } from '@/core/ui/colors.ts';
import type { Console } from '@/core/ui/console.ts';
import { columnFormatting } from '@/core/ui/formatter/column-formatting.ts';

import { resolveStatsEntitlement } from './entitlement.ts';
import {
  bar,
  BAR_WIDTH,
  BASE_COLUMN_GAP_WIDTH,
  computeAlignedTotalsLayout,
  printSummaryCard,
} from './text-report-helpers.ts';

export async function renderTextSummary(
  summary: StatsSummary,
  since: StatsSinceChoice,
  ctx: CommandInvocationContext,
): Promise<void> {
  const { console } = ctx;
  if (summary.allTime.totalRuns === 0) {
    printEmptyState(console);
    return;
  }

  const entitlement = await resolveStatsEntitlement(ctx);

  printSummaryCard(summary, since, entitlement, console);
  printAnalyzerBreakdownSection(summary, console);
  printStoppedSection(summary, console);
  printAgentBreakdownSection(summary, console);
  printCallerCommandSection(summary, console);
  printTopRulesSection(summary, console);
  printTriggerLine(summary, console);
}

function printEmptyState(console: Console): void {
  console.print(`${bold('◆ sonar stats')} ${dim('· nothing recorded yet · this machine')}`);
  console.blank();
  console.print(dim('  stats shows what the CLI catches while you work.'));
  console.print(dim('  Install the hooks and it starts counting from your next commit.'));
  console.blank();
  console.print(`  ${dim('→ Install them:')} ${softBlue('sonar integrate')}`);
}

const PERCENT_MULTIPLIER = 100;
const SHARE_PERCENT_WIDTH = 3;

function percentOf(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * PERCENT_MULTIPLIER) : 0;
}

const ANALYZER_DISPLAY_LABELS: Partial<Record<string, string>> = {
  'sonar-secrets': 'secrets',
  sqaa: 'vortex analysis',
  'sca-scanner-cli': 'dependency risks',
};

function analyzerDisplayLabel(analyzer: string): string {
  return ANALYZER_DISPLAY_LABELS[analyzer] ?? analyzer;
}

function printAnalyzerBreakdownSection(summary: StatsSummary, console: Console): void {
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

  console.blank();
  console.print(headingLine);
  for (const a of sorted) {
    console.print(
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

function printStoppedSection(summary: StatsSummary, console: Console): void {
  if (summary.stopped.length === 0) return;
  const ordered = orderStoppedEntries(summary.stopped);
  const total = ordered.reduce((sum, entry) => sum + entry.count, 0);

  console.blank();
  console.print(bold(`Secrets blocked · ${total} total`));

  const [pointWidth] = columnFormatting([
    [...ordered.map((entry) => STOP_POINT_COPY[entry.point].label)],
  ]);
  const [countWidth] = columnFormatting([[...ordered.map((entry) => String(entry.count))]]);

  for (const entry of ordered) {
    const { label, detail } = STOP_POINT_COPY[entry.point];
    console.print(
      `    ${label.padEnd(pointWidth)}   ${String(entry.count).padStart(countWidth)}   ${detail}`,
    );
  }

  if (summary.topSecretTypes.length > 0) {
    const line = summary.topSecretTypes.map((t) => `${t.count} ${t.label}`).join(' · ');
    console.print(`    ${line}`);
  }
}

const SHARE_BAR_GAP = '  ';
const UNIDENTIFIED_AGENT_LABEL = 'unidentified';
const NO_AGENT_DISPLAY_LABEL = 'no agent';
const NO_AGENT_EXPLANATION = 'no agent: run manually, via a script, or by an unrecognized agent';

function agentDisplayLabel(agent: string): string {
  return agent === UNIDENTIFIED_AGENT_LABEL ? NO_AGENT_DISPLAY_LABEL : agent;
}

function printAgentBreakdownSection(summary: StatsSummary, console: Console): void {
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

  console.blank();
  console.print(headingLine);

  for (const agent of summary.agentBreakdown) {
    const share = percentOf(agent.findings, totalFindings);
    const percentCell = `${share}%`.padStart(percentWidth);
    console.print(
      `    ${agentDisplayLabel(agent.agent).padEnd(agentWidth)}   ${bar(share / PERCENT_MULTIPLIER)}${SHARE_BAR_GAP}${percentCell}${rowGap}${String(agent.findings).padStart(issuesWidth)}`,
    );
  }

  if (summary.agentHitRate) {
    const hitPercent = percentOf(
      summary.agentHitRate.runsWithFindings,
      summary.agentHitRate.totalRuns,
    );
    console.print(`    ${hitPercent}% of all runs surfaced an issue`);
  }

  if (summary.agentBreakdown.some((agent) => agent.agent === UNIDENTIFIED_AGENT_LABEL)) {
    console.print(dim(`    ${NO_AGENT_EXPLANATION}`));
  }
}

function printCallerCommandSection(summary: StatsSummary, console: Console): void {
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

  console.blank();
  console.print(headingLine);
  for (const c of summary.callerCommandBreakdown) {
    console.print(
      `    ${c.command.padEnd(commandWidth)}${rowGap}${String(c.runs).padStart(runsWidth)}`,
    );
  }
}

const MAX_MESSAGE_LINE_LENGTH = 42;
const WRAP_CONTINUATION_EXTRA_INDENT = '  ';

function wrapMessage(message: string): [string, string | null] {
  if (message.length <= MAX_MESSAGE_LINE_LENGTH) return [message, null];
  const lastSpace = message.lastIndexOf(' ', MAX_MESSAGE_LINE_LENGTH);
  if (lastSpace > 0) return [message.slice(0, lastSpace), message.slice(lastSpace + 1)];
  return [message.slice(0, MAX_MESSAGE_LINE_LENGTH), message.slice(MAX_MESSAGE_LINE_LENGTH)];
}

function printTopRulesSection(summary: StatsSummary, console: Console): void {
  if (summary.topRules.length === 0) return;
  console.blank();
  console.print(bold('You keep hitting these issues'));

  const wrapped = summary.topRules.map((rule) => wrapMessage(rule.message ?? ''));
  const [ruleWidth] = columnFormatting([[...summary.topRules.map((rule) => rule.ruleKey)]]);
  const [countWidth] = columnFormatting([[...summary.topRules.map((rule) => String(rule.count))]]);

  summary.topRules.forEach((rule, i) => {
    const [firstLine, continuation] = wrapped[i];
    console.print(
      `    ${firstLine.padEnd(MAX_MESSAGE_LINE_LENGTH)}   ${rule.ruleKey.padEnd(ruleWidth)}   ${String(rule.count).padStart(countWidth)}`,
    );
    if (continuation) {
      console.print(`    ${WRAP_CONTINUATION_EXTRA_INDENT}${continuation}`);
    }
  });
}

function printTriggerLine(summary: StatsSummary, console: Console): void {
  const hooksRuns = summary.triggers.find((t) => t.trigger === 'hooks')?.runs ?? 0;
  const manualRuns = summary.triggers.find((t) => t.trigger === 'manual')?.runs ?? 0;
  const total = hooksRuns + manualRuns;
  if (total === 0) return;

  console.blank();
  console.print(
    `    ${percentOf(hooksRuns, total)}% ran from hooks  ·  ${percentOf(manualRuns, total)}% ran directly`,
  );
}
