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

import { formatDependencyRisksJson } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/format-dependency-risks-json.ts';
import { PackageIdentity } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model';
import {
  mockDependencyRisksViewModel,
  mockLicenseGroupVM,
  mockLicenseRiskVM,
  mockMalwareGroupVM,
  mockPackageVM,
  mockVulnerabilityGroupVM,
  mockVulnerabilityRiskVM,
  pkgId,
} from './_helpers.ts';

describe('formatDependencyRisksJson', () => {
  it('emits the project key and the ViewModel fields as pretty-printed JSON', () => {
    const out = formatDependencyRisksJson(
      'demo-project',
      mockDependencyRisksViewModel({
        packages: [],
        packagesScanned: 1,
        errors: [{ code: 'UNKNOWN', path: null, message: 'err' }],
      }),
    );
    const parsed = JSON.parse(out) as Record<string, unknown>;

    expect(parsed.project).toBe('demo-project');
    expect(parsed.packages).toEqual([]);
    expect(parsed.errors).toEqual([{ code: 'UNKNOWN', path: null, message: 'err' }]);
    expect(parsed.summary).toMatchObject({ packagesScanned: 1, totalRisks: 0 });
    expect(out).toContain('\n  "project": "demo-project"');
  });

  it('serializes an empty response as an empty payload with the project key', () => {
    const out = formatDependencyRisksJson(
      'demo',
      mockDependencyRisksViewModel({ packages: [], packagesScanned: 0 }),
    );
    const parsed = JSON.parse(out) as Record<string, unknown>;

    expect(parsed.project).toBe('demo');
    expect(parsed.packages).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.summary).toMatchObject({ packagesScanned: 0, totalRisks: 0 });
  });

  it('serializes a release with issues into a package entry with risk groups', () => {
    const lodash = pkgId('pkg:npm/lodash@1.0.0');
    const pkg = mockPackageVM({
      package: lodash,
      chains: [[lodash]],
      groups: [
        mockVulnerabilityGroupVM({
          selectedRisks: [mockVulnerabilityRiskVM({ vulnerabilityId: 'CVE-1', cvssScore: '7.5' })],
        }),
      ],
    });
    const parsed = JSON.parse(
      formatDependencyRisksJson('demo', mockDependencyRisksViewModel({ packages: [pkg] })),
    ) as {
      packages: {
        package: string;
        chains: string[][];
        groups: { type: string; risks: unknown[] }[];
      }[];
    };

    expect(parsed.packages).toHaveLength(1);
    expect(parsed.packages[0].package).toBe('pkg:npm/lodash@1.0.0');
    expect(parsed.packages[0].chains).toEqual([['pkg:npm/lodash@1.0.0']]);
    expect(parsed.packages[0].groups).toHaveLength(1);
    expect(parsed.packages[0].groups[0]).toMatchObject({ type: 'VULNERABILITY' });
  });

  it('emits a recommendation object under each risk group', () => {
    const pkg = mockPackageVM({
      package: new PackageIdentity('pkg:npm/mal@1.0.0', 'mal', '1.0.0', 'npm'),
      groups: [
        mockMalwareGroupVM(),
        mockLicenseGroupVM({ selectedRisks: [mockLicenseRiskVM({ spdxLicenseId: 'GPL-3.0' })] }),
        mockVulnerabilityGroupVM({
          selectedRisks: [mockVulnerabilityRiskVM({ vulnerabilityId: 'CVE-1', cvssScore: '7.5' })],
          recommendation: {
            action: 'UPGRADE_PACKAGE',
            fixVersions: [
              { version: '2.0.0', descriptionCode: 'LATEST_STABLE', vulnerabilityIds: [] },
            ],
          },
        }),
      ],
    });
    const parsed = JSON.parse(
      formatDependencyRisksJson('demo', mockDependencyRisksViewModel({ packages: [pkg] })),
    ) as {
      packages: {
        groups: { type: string; recommendation: { action: string; fixVersions: unknown[] } }[];
      }[];
    };

    const byType = Object.fromEntries(
      parsed.packages[0].groups.map((g) => [g.type, g.recommendation]),
    );
    expect(byType.MALWARE).toEqual({ action: 'REMOVE_PACKAGE', fixVersions: [] });
    expect(byType.PROHIBITED_LICENSE).toEqual({ action: 'REVIEW_LICENSE', fixVersions: [] });
    expect(byType.VULNERABILITY.action).toBe('UPGRADE_PACKAGE');
    expect(byType.VULNERABILITY.fixVersions).toEqual([
      { version: '2.0.0', descriptionCode: 'LATEST_STABLE', vulnerabilityIds: [] },
    ]);
  });

  it('emits a summary.packages array with per-package recommendations and risk count', () => {
    const pkg = mockPackageVM({
      package: new PackageIdentity('pkg:npm/mal@1.0.0', 'mal', '1.0.0', 'npm'),
      groups: [mockMalwareGroupVM()],
    });
    const parsed = JSON.parse(
      formatDependencyRisksJson('demo', mockDependencyRisksViewModel({ packages: [pkg] })),
    ) as {
      summary: {
        packages: {
          package: string;
          riskCount: number;
          recommendations: Record<string, { action: string; fixVersions: unknown[] }>;
        }[];
      };
    };

    expect(parsed.summary.packages).toHaveLength(1);
    expect(parsed.summary.packages[0].package).toBe('pkg:npm/mal@1.0.0');
    expect(parsed.summary.packages[0].riskCount).toBe(1);
    expect(parsed.summary.packages[0].recommendations).toEqual({
      MALWARE: { action: 'REMOVE_PACKAGE', fixVersions: [] },
    });
  });
});
