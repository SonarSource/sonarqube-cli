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

import {
  buildRiskFilter,
  type RiskFilterDescription,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/risk-filter.ts';
import {
  type DependencyRisksViewModel,
  type ErrorVM,
  type FixVersionVM,
  type LicenseGroupVM,
  type LicenseRiskVM,
  type MalwareGroupVM,
  type MalwareRiskVM,
  PackageIdentity,
  type PackageVM,
  type RecommendationVM,
  type VulnerabilityGroupVM,
  type VulnerabilityRiskVM,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model';
import { buildSummaryVM } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/build';

export function pkgId(purl: string): PackageIdentity {
  const atIdx = purl.lastIndexOf('@');
  const version = atIdx > 0 ? purl.slice(atIdx + 1) : '';
  const rest = atIdx > 0 ? purl.slice(0, atIdx) : purl;
  const match = /^pkg:([^/]+)\/(.+)$/.exec(rest);
  return match
    ? new PackageIdentity(purl, match[2], version, match[1])
    : new PackageIdentity(purl, purl, '', '');
}

export function mockMalwareRiskVM(overrides: Partial<MalwareRiskVM> = {}): MalwareRiskVM {
  return { severity: 'BLOCKER', status: 'OPEN', ...overrides };
}

export function mockLicenseRiskVM(overrides: Partial<LicenseRiskVM> = {}): LicenseRiskVM {
  return {
    severity: 'HIGH',
    status: 'OPEN',
    spdxLicenseId: 'GPL-3.0',
    releaseLicenseExpression: null,
    ...overrides,
  };
}

export function mockVulnerabilityRiskVM(
  overrides: Partial<VulnerabilityRiskVM> = {},
): VulnerabilityRiskVM {
  return {
    severity: 'HIGH',
    status: 'OPEN',
    vulnerabilityId: 'CVE-2024-0001',
    cvssScore: null,
    partialFixes: [],
    ...overrides,
  };
}

export function mockFixVersion(overrides: Partial<FixVersionVM> = {}): FixVersionVM {
  return {
    version: '2.0.0',
    descriptionCode: 'LATEST_STABLE',
    vulnerabilityIds: [],
    ...overrides,
  };
}

export function mockMalwareGroupVM(overrides: Partial<MalwareGroupVM> = {}): MalwareGroupVM {
  const selectedRisks = overrides.selectedRisks ?? [mockMalwareRiskVM()];
  return {
    type: 'MALWARE',
    selectedRisks,
    recommendation: { action: 'REMOVE_PACKAGE', fixVersions: [] },
    totalKnownRisksCount: selectedRisks.length,
    ...overrides,
  };
}

export function mockLicenseGroupVM(overrides: Partial<LicenseGroupVM> = {}): LicenseGroupVM {
  const selectedRisks = overrides.selectedRisks ?? [mockLicenseRiskVM()];
  return {
    type: 'PROHIBITED_LICENSE',
    selectedRisks,
    recommendation: { action: 'REVIEW_LICENSE', fixVersions: [] },
    totalKnownRisksCount: selectedRisks.length,
    ...overrides,
  };
}

export function mockVulnerabilityGroupVM(
  overrides: Partial<VulnerabilityGroupVM> = {},
): VulnerabilityGroupVM {
  const selectedRisks = overrides.selectedRisks ?? [mockVulnerabilityRiskVM()];
  const recommendation: RecommendationVM = overrides.recommendation ?? {
    action: 'NO_FIX_AVAILABLE',
    fixVersions: [],
  };
  return {
    type: 'VULNERABILITY',
    selectedRisks,
    recommendation,
    totalKnownRisksCount: selectedRisks.length,
    ...overrides,
  };
}

export function mockPackageVM(overrides: Partial<PackageVM> = {}): PackageVM {
  const identity =
    overrides.package ?? new PackageIdentity('pkg:npm/lodash@4.17.21', 'lodash', '4.17.21', 'npm');
  const groups = overrides.groups ?? [mockVulnerabilityGroupVM()];
  return {
    package: identity,
    newlyIntroduced: false,
    riskCount: groups.reduce((n, g) => n + g.selectedRisks.length, 0),
    filePaths: ['package-lock.json'],
    chains: [[identity]],
    groups,
    ...overrides,
  };
}

export function mockFilter(): RiskFilterDescription {
  return buildRiskFilter('all')!.description;
}

export function mockDependencyRisksViewModel(
  overrides: Partial<DependencyRisksViewModel> & { packagesScanned?: number } = {},
): DependencyRisksViewModel {
  const packages = overrides.packages ?? [];
  const errors: ErrorVM[] = overrides.errors ?? [];
  const packagesScanned = overrides.packagesScanned ?? packages.length;
  return {
    packages,
    errors,
    summary: overrides.summary ?? buildSummaryVM(packages, packagesScanned, mockFilter()),
  };
}
