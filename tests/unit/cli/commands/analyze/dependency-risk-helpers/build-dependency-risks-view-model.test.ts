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

import { buildRiskFilter } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/risk-filter.ts';
import type { AnalyzeProjectResponse } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import { buildDependencyRisksViewModel } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/build';
import { countUnresolvedIssues } from '../../../../../../src/cli/commands/analyze/dependency-risks.ts';
import {
  mockScaRelease,
  mockScaResponse,
  mockVulnerabilityRisk,
} from './view-model/build/_helpers.ts';

function buildVM(response: AnalyzeProjectResponse, statuses: string) {
  return buildDependencyRisksViewModel(response, buildRiskFilter(statuses)!);
}

describe('buildDependencyRisksViewModel — orchestration', () => {
  it('returns the expected packages, errors, and summary for a representative response', () => {
    const response = mockScaResponse(
      [
        mockScaRelease({
          packageName: 'a',
          issues: [mockVulnerabilityRisk({ vulnerabilityId: 'CVE-A' })],
        }),
        mockScaRelease({ packageName: 'b', issues: [] }),
      ],
      { errors: [{ id: 'e1', code: 'UNKNOWN', path: null, message: 'oops' }] },
    );

    const vm = buildVM(response, 'all');

    expect(vm.packages.map((p) => p.package.name)).toEqual(['a']);
    expect(vm.errors).toEqual([{ code: 'UNKNOWN', path: null, message: 'oops' }]);
    expect(vm.summary.packagesScanned).toBe(2);
    expect(vm.summary.totalRisks).toBe(1);
  });

  it('sorts packages by purl across releases that produced VMs', () => {
    const response = mockScaResponse([
      mockScaRelease({ packageName: 'zeta', version: '1.0.0', issues: [mockVulnerabilityRisk()] }),
      mockScaRelease({ packageName: 'alpha', version: '2.0.0', issues: [mockVulnerabilityRisk()] }),
      mockScaRelease({ packageName: 'mid', version: '0.0.1', issues: [mockVulnerabilityRisk()] }),
    ]);

    const vm = buildVM(response, 'all');

    expect(vm.packages.map((p) => `${p.package.name}@${p.package.version}`)).toEqual([
      'alpha@2.0.0',
      'mid@0.0.1',
      'zeta@1.0.0',
    ]);
  });

  it('drops packages whose risks are all filtered out, while keeping their release in the scanned count', () => {
    const response = mockScaResponse([
      mockScaRelease({ packageName: 'a', issues: [mockVulnerabilityRisk({ status: 'SAFE' })] }),
      mockScaRelease({ packageName: 'b', issues: [mockVulnerabilityRisk({ status: 'OPEN' })] }),
      mockScaRelease({ packageName: 'c', issues: [] }),
    ]);

    const vm = buildVM(response, 'active');

    expect(vm.packages.map((p) => p.package.name)).toEqual(['b']);
    expect(vm.summary.packagesScanned).toBe(3);
  });

  it('does not mutate the input response or its releases', () => {
    const release = mockScaRelease({
      issues: [
        mockVulnerabilityRisk({ status: 'SAFE' }),
        mockVulnerabilityRisk({ status: 'OPEN' }),
      ],
    });
    const response = mockScaResponse([release]);
    const issuesBefore = release.issues.length;
    const releasesBefore = response.releases.length;

    buildVM(response, 'active');

    expect(release.issues.length).toBe(issuesBefore);
    expect(response.releases.length).toBe(releasesBefore);
  });
});

describe('countUnresolvedIssues', () => {
  it('counts only unresolved risks across all packages', () => {
    const vm = buildVM(
      mockScaResponse([
        mockScaRelease({
          packageName: 'existing',
          issues: [
            mockVulnerabilityRisk({ vulnerabilityId: 'CVE-OPEN', status: 'OPEN' }),
            mockVulnerabilityRisk({ vulnerabilityId: 'CVE-SAFE', status: 'SAFE' }),
            mockVulnerabilityRisk({ vulnerabilityId: 'CVE-FIXED', status: 'FIXED' }),
            mockVulnerabilityRisk({ vulnerabilityId: 'CVE-ACCEPT', status: 'ACCEPT' }),
            mockVulnerabilityRisk({ vulnerabilityId: 'CVE-CONFIRM', status: 'CONFIRM' }),
          ],
        }),
        mockScaRelease({
          packageName: 'fresh',
          newlyIntroduced: true,
          issues: [mockVulnerabilityRisk({ vulnerabilityId: 'CVE-NEW', status: null })],
        }),
      ]),
      'all',
    );

    expect(countUnresolvedIssues(vm)).toBe(3);
  });

  it("returns the count of new risks when applied to the 'new' filter result", () => {
    const vm = buildVM(
      mockScaResponse([
        mockScaRelease({
          packageName: 'existing',
          issues: [
            mockVulnerabilityRisk({ vulnerabilityId: 'CVE-OPEN', status: 'OPEN' }),
            mockVulnerabilityRisk({ vulnerabilityId: 'CVE-SAFE', status: 'SAFE' }),
          ],
        }),
        mockScaRelease({
          packageName: 'fresh',
          newlyIntroduced: true,
          issues: [
            mockVulnerabilityRisk({ vulnerabilityId: 'CVE-NEW-1', status: null }),
            mockVulnerabilityRisk({ vulnerabilityId: 'CVE-NEW-2', status: null }),
          ],
        }),
      ]),
      'new',
    );

    expect(countUnresolvedIssues(vm)).toBe(2);
  });
});
