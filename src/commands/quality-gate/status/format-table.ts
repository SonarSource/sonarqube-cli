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

import { MAX_PAGE_SIZE } from '@/core/server/projects.ts';
import { cyan, green, red, yellow } from '@/core/ui/colors.ts';
import { padColumns } from '@/core/ui/formatter/column-formatting.ts';

import type {
  DependencyRiskBreakdownEntry,
  DuplicationsBreakdownEntry,
  IssuesBreakdownEntry,
  QualityGateBreakdownEntry,
  QualityGateConditionSummary,
  QualityGateMetricBreakdown,
} from './condition-summary.ts';
import type { QualityGateScope } from './scope.ts';
import type { QualityGateVerdict } from './verdict.ts';

/** Fits "Coverage on New Code" without padding. */
const MIN_CONDITION_LABEL_WIDTH = 20;
const CONDITION_LABEL_GAP = 2;
const CONDITION_VALUE_GAP = 2;

const BREAKDOWN_VALUE_GAP = 2;
/** One indent level deeper than a condition line. */
const BREAKDOWN_INDENT = '        ';

const VERDICT_BRACKETS: Record<QualityGateVerdict, string> = {
  OK: '[✓ Passed]',
  ERROR: '[✗ Failed]',
  NOT_COMPUTED: '[⚠ Not computed]',
};

/**
 * The comparator describes when the condition *fails*,
 * so passing requires the inclusive opposite bound.
 */
const INVERSE_COMPARATOR_SYMBOLS: Record<string, string> = {
  LT: '≥',
  GT: '≤',
  EQ: '≠',
  NE: '=',
};

export interface QualityGateTableViewModel {
  verdict: QualityGateVerdict;
  project: string;
  scope: QualityGateScope;
  conditions: QualityGateConditionSummary[];
}

export function formatQualityGateTable(vm: QualityGateTableViewModel): string {
  const lines: string[] = [
    `=== Quality Gate: ${formatVerdictBracket(vm.verdict)} ===`,
    `Project:      ${vm.project}`,
    formatScopeLine(vm.scope),
  ];

  if (vm.verdict === 'NOT_COMPUTED') {
    lines.push('', `${cyan('ℹ')}  ${notComputedHint(vm.scope)}`);
  }

  if (vm.conditions.length > 0) {
    const [values] = padColumns(
      [vm.conditions.map((condition) => condition.formattedActualValue ?? '—')],
      [],
      CONDITION_VALUE_GAP,
    );
    const [labels] = padColumns(
      [vm.conditions.map((condition) => condition.metricName)],
      [MIN_CONDITION_LABEL_WIDTH],
      CONDITION_LABEL_GAP,
    );
    lines.push(
      '',
      'Conditions:',
      ...vm.conditions.flatMap((condition, i) => [
        formatConditionLine(condition, values[i], labels[i]),
        ...formatBreakdownLines(condition),
      ]),
    );
  }

  return lines.join('\n');
}

function formatScopeLine(scope: QualityGateScope): string {
  if (scope.kind === 'pullRequestAuto') {
    return `Pull Request: ${scope.value} (auto-detected from branch ${scope.detectedFromBranch})`;
  }
  if (scope.kind === 'pullRequest') {
    return `Pull Request: ${scope.value}`;
  }
  return `Branch:       ${scope.value}${scope.kind === 'default' ? ' (default)' : ''}`;
}

function formatVerdictBracket(verdict: QualityGateVerdict): string {
  const bracket = VERDICT_BRACKETS[verdict];
  switch (verdict) {
    case 'OK':
      return green(bracket);
    case 'ERROR':
      return red(bracket);
    case 'NOT_COMPUTED':
      return yellow(bracket);
  }
}

function formatConditionLine(
  condition: QualityGateConditionSummary,
  paddedValue: string,
  paddedLabel: string,
): string {
  const marker = condition.status === 'OK' ? green('✓') : red('✗');
  const requirement =
    condition.formattedThreshold !== undefined
      ? `(required ${INVERSE_COMPARATOR_SYMBOLS[condition.comparator] ?? condition.comparator} ${condition.formattedThreshold})`
      : '';
  return `    ${marker}  ${paddedValue}${paddedLabel}${requirement}`;
}

function formatBreakdownLines(condition: QualityGateConditionSummary): string[] {
  const metricBreakdown = condition.breakdown;
  if (!metricBreakdown || metricBreakdown.entries.length === 0) {
    return [];
  }

  const lines = formatEntryLines(metricBreakdown);

  const remaining = metricBreakdown.totalCount - metricBreakdown.fetchedCount;
  if (remaining > 0) {
    lines.push(formatMoreEntriesLine(metricBreakdown, remaining));
  }

  return lines;
}

function formatEntryLines(metricBreakdown: QualityGateMetricBreakdown): string[] {
  switch (metricBreakdown.category) {
    case 'coverage':
      return formatFileEntryLines(metricBreakdown.entries, (entry) => entry.path);
    case 'duplications':
      return formatFileEntryLines(metricBreakdown.entries, formatDuplicationsSuffix);
    case 'issues':
      return formatIssuesEntryLines(metricBreakdown.entries);
    case 'dependency-risks':
      return formatDependencyRiskEntryLines(metricBreakdown.entries);
  }
}

/** Issues have no single value to lead with - file:line/key/rule are their own aligned columns. */
function formatIssuesEntryLines(entries: IssuesBreakdownEntry[]): string[] {
  const [locationColumn, keyColumn, ruleColumn] = padColumns(
    [
      entries.map((entry) => `${entry.file}:${entry.line ?? '?'}`),
      entries.map((entry) => entry.key),
      entries.map((entry) => entry.rule),
    ],
    [],
    BREAKDOWN_VALUE_GAP,
  );
  return entries.map(
    (entry, i) =>
      `${BREAKDOWN_INDENT}${locationColumn[i]}${keyColumn[i]}${ruleColumn[i]}${entry.message}`,
  );
}

function formatFileEntryLines<T extends QualityGateBreakdownEntry>(
  entries: T[],
  renderSuffix: (entry: T) => string,
): string[] {
  const [values] = padColumns(
    [entries.map((entry) => entry.formattedValue)],
    [],
    BREAKDOWN_VALUE_GAP,
  );
  return entries.map((entry, i) => `${BREAKDOWN_INDENT}${values[i]}${renderSuffix(entry)}`);
}

function formatDuplicationsSuffix(entry: DuplicationsBreakdownEntry): string {
  if (entry.blockCount === undefined) {
    return entry.path;
  }
  const blocks = `${entry.blockCount} block${entry.blockCount === 1 ? '' : 's'}`;
  const peers = entry.duplicatesWith?.length ? `, dup: ${entry.duplicatesWith.join(', ')}` : '';
  return `${entry.path} (${blocks}${peers})`;
}

function formatDependencyRiskEntryLines(entries: DependencyRiskBreakdownEntry[]): string[] {
  const [identifiers, severities, types] = padColumns(
    [
      entries.map((entry) => `${entry.package}@${entry.version}`),
      entries.map((entry) => entry.severity),
      entries.map((entry) => entry.type),
    ],
    [],
    BREAKDOWN_VALUE_GAP,
  );
  return entries.map((entry, i) =>
    `${BREAKDOWN_INDENT}${identifiers[i]}${severities[i]}${types[i]}${entry.vulnerabilityId ?? ''}`.trimEnd(),
  );
}

function formatMoreEntriesLine(
  metricBreakdown: QualityGateMetricBreakdown,
  remaining: number,
): string {
  const suggestedTop = Math.min(metricBreakdown.totalCount, MAX_PAGE_SIZE);
  const showsEverything = metricBreakdown.totalCount <= MAX_PAGE_SIZE;
  // A suggestion that isn't higher than what was already requested would be a no-op - e.g.
  // --top is already at MAX_PAGE_SIZE, so the API's own cap, not --top, is what's left out.
  let suffix: string;
  if (suggestedTop > metricBreakdown.fetchedCount) {
    suffix = `use --top ${suggestedTop} to display ${showsEverything ? 'all' : 'more'}`;
  } else {
    suffix = `capped at ${MAX_PAGE_SIZE} results per fetch`;
  }
  return `${BREAKDOWN_INDENT}… ${remaining} more · ${suffix}`;
}

function notComputedHint(scope: QualityGateScope): string {
  const subject =
    scope.kind === 'pullRequest' || scope.kind === 'pullRequestAuto' ? 'pull request' : 'branch';
  return `This ${subject} either doesn't exist, hasn't been analyzed yet, or analysis ran but the quality gate status is not updated yet. You can run \`sonar analyze\` for local analysis.`;
}
