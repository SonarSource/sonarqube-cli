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

import { describe, expect, it } from 'bun:test';

import { countSelectedRisksBySeverity } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/count-selected-risks.ts';
import { buildRiskFilter } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/risk-filter.ts';
import { buildDependencyRisksViewModel } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/build';
import {
  mockMalwareRisk,
  mockScaRelease,
  mockScaResponse,
  mockVulnerabilityRisk,
} from './view-model/build/_helpers.ts';

describe('countSelectedRisksBySeverity', () => {
  it('tallies selected risks per severity, with zero for absent severities', () => {
    const response = mockScaResponse([
      mockScaRelease({
        issues: [
          mockVulnerabilityRisk({ vulnerabilityId: 'CVE-1', severity: 'HIGH' }),
          mockMalwareRisk({ severity: 'BLOCKER' }),
        ],
      }),
    ]);
    const vm = buildDependencyRisksViewModel(response, buildRiskFilter('all')!);

    expect(countSelectedRisksBySeverity(vm)).toEqual({
      BLOCKER: 1,
      HIGH: 1,
      MEDIUM: 0,
      LOW: 0,
      INFO: 0,
    });
  });
});
