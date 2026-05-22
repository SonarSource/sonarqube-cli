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

import {
  buildRiskFilter,
  type RiskFilterDescription,
} from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/risk-filter.ts';
import type {
  ScaIssueType,
  Severity,
} from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import type { PackageVM } from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model';
import {
  buildPackageIdentityMap,
  buildPackageVM,
  buildSummaryVM,
} from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/build';
import {
  mockLicenseRisk,
  mockMalwareRisk,
  mockScaRelease,
  mockVulnerabilityRisk,
} from './_helpers.ts';

const DEFAULT_FILTER: RiskFilterDescription = buildRiskFilter('all')!.description;

const ALLOW_ALL = () => true;

function buildPackage(
  ...issuesPerRelease: Parameters<typeof mockVulnerabilityRisk>[0][][]
): PackageVM[] {
  const releases = issuesPerRelease.map((issues, i) =>
    mockScaRelease({
      packageName: `pkg${i}`,
      packageUrl: `pkg:npm/pkg${i}@1.0.0`,
      issues: issues.map((overrides, j) => {
        const base = mockVulnerabilityRisk(overrides);
        return { ...base, key: `issue-${i}-${j}` };
      }),
    }),
  );
  const identityByPurl = buildPackageIdentityMap(releases);
  return releases
    .map((r) => buildPackageVM(r, ALLOW_ALL, identityByPurl))
    .filter((p): p is PackageVM => p !== null);
}

describe('buildSummaryVM', () => {
  it('packagesScanned reflects the count passed in, independent of surviving packages', () => {
    const packages = buildPackage([{ severity: 'HIGH' }]);

    const summary = buildSummaryVM(packages, 42, DEFAULT_FILTER);

    expect(summary.packagesScanned).toBe(42);
  });

  it('totalRisks sums riskCount across all packages', () => {
    const packages = buildPackage(
      [{ severity: 'HIGH' }, { severity: 'LOW' }],
      [{ severity: 'BLOCKER' }],
    );

    const summary = buildSummaryVM(packages, packages.length, DEFAULT_FILTER);

    expect(summary.totalRisks).toBe(3);
  });

  it('byType seeds every (type, severity) cell with 0', () => {
    const summary = buildSummaryVM([], 0, DEFAULT_FILTER);

    const types: ScaIssueType[] = ['MALWARE', 'PROHIBITED_LICENSE', 'VULNERABILITY'];
    const severities: Severity[] = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
    for (const type of types) {
      const row = summary.byType.get(type);
      expect(row).toBeDefined();
      for (const sev of severities) {
        expect(row!.get(sev)).toBe(0);
      }
    }
  });

  it('counts each risk under its (group.type, risk.severity) cell', () => {
    const release = mockScaRelease({
      issues: [
        mockVulnerabilityRisk({ severity: 'BLOCKER', vulnerabilityId: 'CVE-1' }),
        mockVulnerabilityRisk({ severity: 'BLOCKER', vulnerabilityId: 'CVE-2' }),
        mockVulnerabilityRisk({ severity: 'HIGH', vulnerabilityId: 'CVE-3' }),
        mockLicenseRisk({ severity: 'MEDIUM' }),
        mockMalwareRisk({ severity: 'BLOCKER' }),
      ],
    });
    const identityByPurl = buildPackageIdentityMap([release]);
    const pkg = buildPackageVM(release, ALLOW_ALL, identityByPurl)!;

    const summary = buildSummaryVM([pkg], 1, DEFAULT_FILTER);

    expect(summary.byType.get('VULNERABILITY')!.get('BLOCKER')).toBe(2);
    expect(summary.byType.get('VULNERABILITY')!.get('HIGH')).toBe(1);
    expect(summary.byType.get('PROHIBITED_LICENSE')!.get('MEDIUM')).toBe(1);
    expect(summary.byType.get('MALWARE')!.get('BLOCKER')).toBe(1);
    expect(summary.byType.get('VULNERABILITY')!.get('LOW')).toBe(0);
  });

  it('sums counts across multiple packages', () => {
    const packages = buildPackage(
      [
        { severity: 'LOW', vulnerabilityId: 'CVE-A1' },
        { severity: 'LOW', vulnerabilityId: 'CVE-A2' },
      ],
      [{ severity: 'LOW', vulnerabilityId: 'CVE-B1' }],
    );

    const summary = buildSummaryVM(packages, packages.length, DEFAULT_FILTER);

    expect(summary.byType.get('VULNERABILITY')!.get('LOW')).toBe(3);
  });

  it('produces an all-zero byType when there are no packages', () => {
    const summary = buildSummaryVM([], 5, DEFAULT_FILTER);

    expect(summary.totalRisks).toBe(0);
    expect(summary.packagesScanned).toBe(5);
    for (const row of summary.byType.values()) {
      for (const count of row.values()) {
        expect(count).toBe(0);
      }
    }
  });

  it('packages is empty when no packages survived', () => {
    expect(buildSummaryVM([], 5, DEFAULT_FILTER).packages).toEqual([]);
  });
});

describe('buildSummaryVM — per-package recommendations', () => {
  it('emits one entry per package with its riskCount and a recommendation keyed by group type', () => {
    const release = mockScaRelease({
      packageName: 'mixed',
      issues: [mockMalwareRisk(), mockLicenseRisk(), mockVulnerabilityRisk()],
    });
    const identityByPurl = buildPackageIdentityMap([release]);
    const pkg = buildPackageVM(release, ALLOW_ALL, identityByPurl)!;

    const summary = buildSummaryVM([pkg], 1, DEFAULT_FILTER);

    expect(summary.packages).toHaveLength(1);
    expect(summary.packages[0].package).toBe(pkg.package);
    expect(summary.packages[0].riskCount).toBe(pkg.riskCount);
    const recs = summary.packages[0].recommendations;
    expect(recs.get('MALWARE')?.action).toBe('REMOVE_PACKAGE');
    expect(recs.get('PROHIBITED_LICENSE')?.action).toBe('REVIEW_LICENSE');
    expect(recs.get('VULNERABILITY')?.action).toBe('NO_FIX_AVAILABLE');
  });

  it('reflects multiple packages, preserving order from the input', () => {
    const packages = buildPackage(
      [{ severity: 'HIGH', vulnerabilityId: 'CVE-A' }],
      [{ severity: 'LOW', vulnerabilityId: 'CVE-B' }],
    );

    const summary = buildSummaryVM(packages, packages.length, DEFAULT_FILTER);

    expect(summary.packages.map((p) => p.package.name)).toEqual(['pkg0', 'pkg1']);
    expect(summary.packages.every((p) => p.recommendations.size === 1)).toBe(true);
  });

  it('highestSeverity is the worst severity across all risks in the package', () => {
    const release = mockScaRelease({
      issues: [
        mockVulnerabilityRisk({ severity: 'LOW', vulnerabilityId: 'CVE-1' }),
        mockLicenseRisk({ severity: 'HIGH' }),
        mockVulnerabilityRisk({ severity: 'MEDIUM', vulnerabilityId: 'CVE-2' }),
      ],
    });
    const identityByPurl = buildPackageIdentityMap([release]);
    const pkg = buildPackageVM(release, ALLOW_ALL, identityByPurl)!;

    const summary = buildSummaryVM([pkg], 1, DEFAULT_FILTER);

    expect(summary.packages[0].highestSeverity).toBe('HIGH');
  });

  it('highestSeverity prefers BLOCKER over HIGH', () => {
    const release = mockScaRelease({
      issues: [
        mockVulnerabilityRisk({ severity: 'HIGH', vulnerabilityId: 'CVE-1' }),
        mockMalwareRisk({ severity: 'BLOCKER' }),
      ],
    });
    const identityByPurl = buildPackageIdentityMap([release]);
    const pkg = buildPackageVM(release, ALLOW_ALL, identityByPurl)!;

    const summary = buildSummaryVM([pkg], 1, DEFAULT_FILTER);

    expect(summary.packages[0].highestSeverity).toBe('BLOCKER');
  });

  it('highestSeverity is computed per package independently', () => {
    const packages = buildPackage(
      [{ severity: 'INFO', vulnerabilityId: 'CVE-A' }],
      [
        { severity: 'LOW', vulnerabilityId: 'CVE-B1' },
        { severity: 'BLOCKER', vulnerabilityId: 'CVE-B2' },
      ],
    );

    const summary = buildSummaryVM(packages, packages.length, DEFAULT_FILTER);

    expect(summary.packages[0].highestSeverity).toBe('INFO');
    expect(summary.packages[1].highestSeverity).toBe('BLOCKER');
  });
});
