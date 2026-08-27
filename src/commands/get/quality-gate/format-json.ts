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

import type { QualityGateConditionSummary } from './condition-summary.ts';
import type { QualityGateScope } from './scope.ts';
import type { QualityGateVerdict } from './verdict.ts';

export interface QualityGateJsonViewModel {
  verdict: QualityGateVerdict;
  project: string;
  scope: QualityGateScope;
  conditions: QualityGateConditionSummary[];
}

export function formatQualityGateJson(vm: QualityGateJsonViewModel): string {
  const isPullRequest = vm.scope.kind === 'pullRequest';
  return JSON.stringify(
    {
      qualityGate: {
        status: vm.verdict,
        project: vm.project,
        branch: isPullRequest ? undefined : vm.scope.value,
        pullRequest: isPullRequest ? vm.scope.value : undefined,
        conditions: vm.conditions,
      },
    },
    null,
    2,
  );
}
