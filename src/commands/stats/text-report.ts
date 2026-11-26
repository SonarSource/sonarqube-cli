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

import type { StatsStopPoint, StatsTopRule } from '@/core/stats/stats-queries.ts';
import { bold, dim, softBlue } from '@/core/ui/colors.ts';
import type { Console } from '@/core/ui/console.ts';
import { columnFormatting } from '@/core/ui/formatter/column-formatting.ts';

import {
  bar,
  BAR_WIDTH,
  BASE_COLUMN_GAP_WIDTH,
  computeAlignedTotalsLayout,
  printSummaryCard,
} from './text-report-helpers.ts';
import {
  type StatsAgentsViewModel,
  type StatsAnalyzersViewModel,
  type StatsCallerCommandsViewModel,
  type StatsStoppedViewModel,
  type StatsTriggersViewModel,
  type StatsViewModel,
  UNIDENTIFIED_AGENT_LABEL,
} from './view-model/types.ts';

export function renderTextSummary(viewModel: StatsViewModel, console: Console): void {
  if (!viewModel.hasHistory) {
    printEmptyState(console);
    return;
  }

  const { window, card, analyzers, stopped, agents, callerCommands, topRules, triggers } =
    viewModel;
  printSummaryCard(window, card, console);
  if (analyzers) {
    printAnalyzerBreakdownSection(analyzers, console);
  }
  if (stopped) {
    printStoppedSection(stopped, console);
  }
  if (agents) {
    printAgentBreakdownSection(agents, console);
  }
  if (callerCommands) {
    printCallerCommandSection(callerCommands, console);
  }
  if (topRules) {
    printTopRulesSection(topRules, console);
  }
  if (triggers) {
    printTriggerLine(triggers, console);
  }
}

function printEmptyState(console: Console): void {
  console.print(`${bold('◆ sonar stats')} ${dim('· nothing recorded yet · this machine')}`);
  console.blank();
  console.print(dim('  stats shows what the CLI catches while you work.'));
  console.print(dim('  Install the hooks and it starts counting from your next commit.'));
  console.blank();
  console.print(`  ${dim('→ Install them:')} ${softBlue('sonar integrate')}`);
}

const SHARE_PERCENT_WIDTH = 3;

const ANALYZER_DISPLAY_LABELS: Partial<Record<string, string>> = {
  'sonar-secrets': 'secrets',
  sqaa: 'vortex analysis',
  'sca-scanner-cli': 'dependency risks',
};

function analyzerDisplayLabel(analyzer: string): string {
  return ANALYZER_DISPLAY_LABELS[analyzer] ?? analyzer;
}

function printAnalyzerBreakdownSection(analyzers: StatsAnalyzersViewModel, console: Console): void {
  const { total: totalRuns, rows } = analyzers;

  const [labelWidth] = columnFormatting([[...rows.map((a) => analyzerDisplayLabel(a.analyzer))]]);
  const [runsWidth] = columnFormatting([[...rows.map((a) => String(a.runs))]]);
  const naturalRowEndColumn = 4 + labelWidth + BASE_COLUMN_GAP_WIDTH + runsWidth;
  const { headingLine, rowGap } = computeAlignedTotalsLayout(
    'Analyses run by scanner',
    totalRuns,
    naturalRowEndColumn,
  );

  console.blank();
  console.print(headingLine);
  for (const a of rows) {
    console.print(
      `    ${analyzerDisplayLabel(a.analyzer).padEnd(labelWidth)}${rowGap}${String(a.runs).padStart(runsWidth)}`,
    );
  }
}

const STOP_POINT_COPY: Record<StatsStopPoint, { label: string; detail: string }> = {
  commit: { label: 'at commit', detail: 'secrets in staged files' },
  prompt: { label: 'at a prompt', detail: 'secrets in prompt text' },
  'file-read': { label: 'at a file read', detail: 'an agent tried to read it' },
  push: { label: 'at push', detail: 'secrets in unpushed commits' },
};

function printStoppedSection(stopped: StatsStoppedViewModel, console: Console): void {
  const { total, entries, topSecretTypes } = stopped;

  console.blank();
  console.print(bold(`Secrets blocked · ${total} total`));

  const [pointWidth] = columnFormatting([
    [...entries.map((entry) => STOP_POINT_COPY[entry.point].label)],
  ]);
  const [countWidth] = columnFormatting([[...entries.map((entry) => String(entry.count))]]);

  for (const entry of entries) {
    const { label, detail } = STOP_POINT_COPY[entry.point];
    console.print(
      `    ${label.padEnd(pointWidth)}   ${String(entry.count).padStart(countWidth)}   ${detail}`,
    );
  }

  if (topSecretTypes.length > 0) {
    const line = topSecretTypes.map((t) => `${t.count} ${t.label}`).join(' · ');
    console.print(`    ${line}`);
  }
}

const SHARE_BAR_GAP = '  ';
const NO_AGENT_DISPLAY_LABEL = 'no agent';
const NO_AGENT_EXPLANATION = 'no agent: run manually, via a script, or by an unrecognized agent';

function agentDisplayLabel(agent: string): string {
  return agent === UNIDENTIFIED_AGENT_LABEL ? NO_AGENT_DISPLAY_LABEL : agent;
}

function printAgentBreakdownSection(agents: StatsAgentsViewModel, console: Console): void {
  const { total: totalFindings, rows, hitPercent, hasUnidentified } = agents;

  const [agentWidth] = columnFormatting([[...rows.map((agent) => agentDisplayLabel(agent.agent))]]);
  const [issuesWidth] = columnFormatting([[...rows.map((agent) => String(agent.findings))]]);
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

  for (const agent of rows) {
    const percentCell = `${agent.sharePercent}%`.padStart(percentWidth);
    console.print(
      `    ${agentDisplayLabel(agent.agent).padEnd(agentWidth)}   ${bar(agent.sharePercent)}${SHARE_BAR_GAP}${percentCell}${rowGap}${String(agent.findings).padStart(issuesWidth)}`,
    );
  }

  if (hitPercent !== null) {
    console.print(`    ${hitPercent}% of all runs surfaced an issue`);
  }

  if (hasUnidentified) {
    console.print(dim(`    ${NO_AGENT_EXPLANATION}`));
  }
}

function printCallerCommandSection(
  callerCommands: StatsCallerCommandsViewModel,
  console: Console,
): void {
  const { total: totalRuns, rows } = callerCommands;

  const [commandWidth] = columnFormatting([[...rows.map((c) => c.command)]]);
  const [runsWidth] = columnFormatting([[...rows.map((c) => String(c.runs))]]);
  const naturalRowEndColumn = 4 + commandWidth + BASE_COLUMN_GAP_WIDTH + runsWidth;
  const { headingLine, rowGap } = computeAlignedTotalsLayout(
    'Runs by command',
    totalRuns,
    naturalRowEndColumn,
  );

  console.blank();
  console.print(headingLine);
  for (const c of rows) {
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

function printTopRulesSection(topRules: StatsTopRule[], console: Console): void {
  console.blank();
  console.print(bold('You keep hitting these issues'));

  const wrapped = topRules.map((rule) => wrapMessage(rule.message ?? ''));
  const [ruleWidth] = columnFormatting([[...topRules.map((rule) => rule.ruleKey)]]);
  const [countWidth] = columnFormatting([[...topRules.map((rule) => String(rule.count))]]);

  topRules.forEach((rule, i) => {
    const [firstLine, continuation] = wrapped[i];
    console.print(
      `    ${firstLine.padEnd(MAX_MESSAGE_LINE_LENGTH)}   ${rule.ruleKey.padEnd(ruleWidth)}   ${String(rule.count).padStart(countWidth)}`,
    );
    if (continuation) {
      console.print(`    ${WRAP_CONTINUATION_EXTRA_INDENT}${continuation}`);
    }
  });
}

function printTriggerLine(triggers: StatsTriggersViewModel, console: Console): void {
  console.blank();
  console.print(
    `    ${triggers.hooksPercent}% ran from hooks  ·  ${triggers.manualPercent}% ran directly`,
  );
}
