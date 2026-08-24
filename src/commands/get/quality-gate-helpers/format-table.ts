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

import { green, red, yellow } from '@/core/ui/colors.ts';

import type { QualityGateConditionSummary } from './condition-summary.ts';
import type { QualityGateVerdict } from './verdict.ts';

const CONDITION_LABEL_WIDTH = 36;
const CONDITION_VALUE_WIDTH = 14;

const VERDICT_BRACKETS: Record<QualityGateVerdict, string> = {
  OK: '[✓ Passed]',
  ERROR: '[✗ Failed]',
  NOT_COMPUTED: '[⚠ Not computed]',
};

/**
 * The API only ever returns `LT`/`GT` (strict "less than"/"greater than" — the comparator
 * describes when the condition *fails*), so passing requires the inclusive opposite bound.
 */
const MIRROR_COMPARATOR_SYMBOLS: Record<string, string> = {
  LT: '≥',
  GT: '≤',
};

export interface QualityGateTableViewModel {
  verdict: QualityGateVerdict;
  project: string;
  conditions: QualityGateConditionSummary[];
}

export function formatQualityGateTable(vm: QualityGateTableViewModel): string {
  const lines: string[] = [
    `=== Quality Gate: ${formatVerdictBracket(vm.verdict)} ===`,
    `Project:      ${vm.project}`,
  ];

  if (vm.conditions.length > 0) {
    lines.push('', 'Conditions:');
    for (const condition of vm.conditions) {
      lines.push(formatConditionLine(condition));
    }
  }

  return lines.join('\n');
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

function formatConditionLine(condition: QualityGateConditionSummary): string {
  const marker = condition.status === 'OK' ? green('✓') : red('✗');
  const label = condition.metric.padEnd(CONDITION_LABEL_WIDTH);
  const value = (condition.actualValue ?? '—').padEnd(CONDITION_VALUE_WIDTH);
  const requirement =
    condition.threshold !== undefined
      ? `(required ${MIRROR_COMPARATOR_SYMBOLS[condition.comparator] ?? condition.comparator} ${condition.threshold})`
      : '';
  return `    ${marker}  ${label}${value}${requirement}`;
}
