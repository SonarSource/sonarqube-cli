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

import { cyan, green, red, yellow } from '@/core/ui/colors.ts';
import { padColumns } from '@/core/ui/formatter/column-formatting.ts';

import type { QualityGateConditionSummary } from './condition-summary.ts';
import type { QualityGateScope } from './scope.ts';
import type { QualityGateVerdict } from './verdict.ts';

/**
 * These are only the floors `padColumns` falls back to - a table of short names stays compact
 * instead of always reserving space for a name long enough to never appear.
 */
const MIN_CONDITION_LABEL_WIDTH = 20;
const MIN_CONDITION_VALUE_WIDTH = 14;
/** Guarantees at least this much space after each column even when its content sets the width. */
const CONDITION_GAP = 2;

const VERDICT_BRACKETS: Record<QualityGateVerdict, string> = {
  OK: '[✓ Passed]',
  ERROR: '[✗ Failed]',
  NOT_COMPUTED: '[⚠ Not computed]',
};

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
    const [labels, values] = padColumns(
      [
        vm.conditions.map((condition) => condition.metricName),
        vm.conditions.map((condition) => condition.actualValue ?? '—'),
      ],
      [MIN_CONDITION_LABEL_WIDTH, MIN_CONDITION_VALUE_WIDTH],
      CONDITION_GAP,
    );
    lines.push(
      '',
      'Conditions:',
      ...vm.conditions.map((condition, i) => formatConditionLine(condition, labels[i], values[i])),
    );
  }

  return lines.join('\n');
}

function formatScopeLine(scope: QualityGateScope): string {
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
  paddedLabel: string,
  paddedValue: string,
): string {
  const marker = condition.status === 'OK' ? green('✓') : red('✗');
  const requirement =
    condition.threshold !== undefined
      ? `(required ${INVERSE_COMPARATOR_SYMBOLS[condition.comparator] ?? condition.comparator} ${condition.threshold})`
      : '';
  return `    ${marker}  ${paddedLabel}${paddedValue}${requirement}`;
}

function notComputedHint(scope: QualityGateScope): string {
  const subject = scope.kind === 'pullRequest' ? 'pull request' : 'branch';
  return `This ${subject} either doesn't exist, hasn't been analyzed yet, or analysis ran but the quality gate status is not updated yet. You can run \`sonar analyze\` for local analysis.`;
}
