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

import { effectiveStatus, sortReleases } from './analysis-response.ts';
import {
  type DependencyRisksViewModel,
  type ErrorVM,
  type FixVersionVM,
  type LicenseGroupVM,
  type LicenseRiskVM,
  type MalwareGroupVM,
  type MalwareRiskVM,
  type PackageVM,
  type RiskGroupVM,
  type RiskVM,
  type SeverityCountVM,
  type SummaryRowVM,
  type SummarySeverity,
  type SummaryVM,
  type VulnerabilityGroupVM,
  type VulnerabilityRiskVM,
} from './dependency-risks-view-model.ts';
import type {
  AnalyzeProjectIssue,
  AnalyzeProjectRelease,
  AnalyzeProjectResponse,
  ScaIssueType,
  VersionOption,
  VersionOptionDescriptionCode,
} from './sca-scanner.ts';

const ISSUE_TYPES: ScaIssueType[] = ['MALWARE', 'PROHIBITED_LICENSE', 'VULNERABILITY'];
const SUMMARY_SEVERITIES: SummarySeverity[] = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

const DESCRIPTION_CODE_ORDER: Record<VersionOptionDescriptionCode, number> = {
  LATEST_STABLE: 0,
  LATEST_COMPLETE: 1,
  LATEST_PRERELEASE: 2,
  LATEST_PARTIAL: 3,
  NEAREST_COMPLETE: 4,
  NEAREST_PARTIAL: 5,
  VERSION_IN_USE: 6,
  UNKNOWN: 7,
};

const EXCLUDED_DESCRIPTION_CODES: ReadonlySet<VersionOptionDescriptionCode> = new Set([
  'VERSION_IN_USE',
  'UNKNOWN',
]);

export function buildDependencyRisksViewModel(
  filtered: AnalyzeProjectResponse,
  allReleases: AnalyzeProjectRelease[],
): DependencyRisksViewModel {
  const sortedReleases = sortReleases(filtered.releases);
  const packages = sortedReleases
    .filter((release) => release.issues.length > 0)
    .map(buildPackageVM);
  return {
    packages,
    errors: filtered.errors.map(buildErrorVM),
    summary: buildSummaryVM(sortedReleases, allReleases.length),
  };
}

function buildPackageVM(release: AnalyzeProjectRelease): PackageVM {
  return {
    name: release.packageName,
    version: release.version,
    newlyIntroduced: release.newlyIntroduced,
    riskCount: release.issues.length,
    filePaths: release.dependencyFilePaths,
    chains: sortChainsShortestFirst(release.dependencyChains),
    groups: buildGroups(release),
  };
}

function sortChainsShortestFirst(chains: string[][]): string[][] {
  return [...chains].sort((a, b) => a.length - b.length);
}

function buildGroups(release: AnalyzeProjectRelease): RiskGroupVM<RiskVM>[] {
  const byType = groupIssuesByType(release.issues);
  const groups: RiskGroupVM<RiskVM>[] = [];
  for (const type of ISSUE_TYPES) {
    const issues = byType.get(type) ?? [];
    if (issues.length === 0) continue;
    groups.push(buildGroup(type, release, issues));
  }
  return groups;
}

function groupIssuesByType(
  issues: AnalyzeProjectIssue[],
): Map<ScaIssueType, AnalyzeProjectIssue[]> {
  const byType = new Map<ScaIssueType, AnalyzeProjectIssue[]>();
  for (const type of ISSUE_TYPES) byType.set(type, []);
  for (const issue of issues) byType.get(issue.type)?.push(issue);
  return byType;
}

function buildGroup(
  type: ScaIssueType,
  release: AnalyzeProjectRelease,
  issues: AnalyzeProjectIssue[],
): MalwareGroupVM | LicenseGroupVM | VulnerabilityGroupVM {
  switch (type) {
    case 'MALWARE':
      return { type, risks: issues.map((i) => buildMalwareRisk(release, i)) };
    case 'PROHIBITED_LICENSE':
      return { type, risks: issues.map((i) => buildLicenseRisk(release, i)) };
    case 'VULNERABILITY':
      return {
        type,
        risks: issues.map((i) => buildVulnerabilityRisk(release, i)),
        packageFixes: selectPackageCompleteFixes(issues),
      };
  }
}

function buildMalwareRisk(
  release: AnalyzeProjectRelease,
  issue: AnalyzeProjectIssue,
): MalwareRiskVM {
  return {
    severity: issue.severity.toUpperCase(),
    status: effectiveStatus(release, issue),
  };
}

function buildLicenseRisk(
  release: AnalyzeProjectRelease,
  issue: AnalyzeProjectIssue,
): LicenseRiskVM {
  return {
    severity: issue.severity.toUpperCase(),
    status: effectiveStatus(release, issue),
    spdxLicenseId: issue.spdxLicenseId,
    releaseLicenseExpression: release.licenseExpression,
  };
}

function buildVulnerabilityRisk(
  release: AnalyzeProjectRelease,
  issue: AnalyzeProjectIssue,
): VulnerabilityRiskVM {
  return {
    severity: issue.severity.toUpperCase(),
    status: effectiveStatus(release, issue),
    cvssScore: issue.cvssScore,
    vulnerabilityId: issue.vulnerabilityId ?? '',
    partialFixes: selectIssuePartialFixes(issue),
  };
}

function selectIssuePartialFixes(issue: AnalyzeProjectIssue): FixVersionVM[] {
  const partials = (issue.versionOptions ?? []).filter(
    (o) => o.fixLevel === 'PARTIAL' && !EXCLUDED_DESCRIPTION_CODES.has(o.descriptionCode),
  );
  return sortByDescriptionCode(partials).map(toFixVersionVM);
}

function selectPackageCompleteFixes(issues: AnalyzeProjectIssue[]): FixVersionVM[] {
  const byVersion = new Map<string, VersionOption>();
  for (const issue of issues) {
    for (const option of issue.versionOptions ?? []) {
      if (option.fixLevel !== 'COMPLETE') continue;
      if (EXCLUDED_DESCRIPTION_CODES.has(option.descriptionCode)) continue;
      if (!byVersion.has(option.version)) byVersion.set(option.version, option);
    }
  }
  return sortByDescriptionCode([...byVersion.values()]).map(toFixVersionVM);
}

function sortByDescriptionCode(options: VersionOption[]): VersionOption[] {
  return [...options].sort(
    (a, b) => DESCRIPTION_CODE_ORDER[a.descriptionCode] - DESCRIPTION_CODE_ORDER[b.descriptionCode],
  );
}

function toFixVersionVM(option: VersionOption): FixVersionVM {
  return {
    version: option.version,
    descriptionCode: option.descriptionCode,
    vulnerabilityIds: option.vulnerabilityIds,
  };
}

function buildErrorVM(error: { code: string; path: string | null; message: string }): ErrorVM {
  return { code: error.code, path: error.path, message: error.message };
}

function buildSummaryVM(
  sortedReleases: AnalyzeProjectRelease[],
  packagesScanned: number,
): SummaryVM {
  const counts = summaryCountsByTypeAndSeverity(sortedReleases);
  return {
    packagesScanned,
    totalRisks: sortedReleases.reduce((n, r) => n + r.issues.length, 0),
    rows: ISSUE_TYPES.map((type) => buildSummaryRow(type, counts.get(type))),
  };
}

function buildSummaryRow(
  type: ScaIssueType,
  countsByType: Map<SummarySeverity, number> | undefined,
): SummaryRowVM {
  const counts: SeverityCountVM[] = SUMMARY_SEVERITIES.map((severity) => ({
    severity,
    count: countsByType?.get(severity) ?? 0,
  }));
  return { type, counts };
}

function summaryCountsByTypeAndSeverity(
  releases: AnalyzeProjectRelease[],
): Map<ScaIssueType, Map<SummarySeverity, number>> {
  const out = new Map<ScaIssueType, Map<SummarySeverity, number>>();
  for (const type of ISSUE_TYPES) {
    const row = new Map<SummarySeverity, number>();
    for (const sev of SUMMARY_SEVERITIES) row.set(sev, 0);
    out.set(type, row);
  }
  for (const release of releases) {
    for (const issue of release.issues) {
      const row = out.get(issue.type);
      if (!row) continue;
      const sev = issue.severity.toUpperCase() as SummarySeverity;
      if (!row.has(sev)) continue;
      row.set(sev, (row.get(sev) ?? 0) + 1);
    }
  }
  return out;
}
