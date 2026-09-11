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

import type { FileQualityGateViewModel, QualityGateViewModel } from './condition-summary.ts';

export function formatQualityGateJson(vm: QualityGateViewModel): string {
  const isPullRequest = vm.scope.kind === 'pullRequest' || vm.scope.kind === 'pullRequestAuto';
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

export function formatFileQualityGateJson(vm: FileQualityGateViewModel): string {
  return JSON.stringify(
    { qualityGate: { status: vm.verdict, file: vm.file, conditions: vm.conditions } },
    null,
    2,
  );
}
