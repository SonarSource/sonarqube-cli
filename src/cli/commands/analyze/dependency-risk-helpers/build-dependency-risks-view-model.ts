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

import logger from '../../../../lib/logger.ts';
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
  type RiskGroupVM,
  type RiskVM,
  type SeverityCountVM,
  type SummaryRowVM,
  type SummarySeverity,
  type SummaryVM,
  type VulnerabilityGroupVM,
  type VulnerabilityRiskVM,
} from './dependency-risks-view-model.ts';
import type { RiskPredicate } from './risk-filter.ts';
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

const SEVERITY_RANK: Record<string, number> = {
  BLOCKER: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

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
  response: AnalyzeProjectResponse,
  filter: RiskPredicate,
): DependencyRisksViewModel {
  const identityByPurl = buildPackageIdentityMap(response.releases);
  const packages: PackageVM[] = [];
  for (const release of response.releases) {
    const pkg = buildPackageVM(release, filter, identityByPurl);
    if (pkg !== null) packages.push(pkg);
  }
  packages.sort((a, b) => a.package.compareTo(b.package));
  return {
    packages,
    errors: response.errors.map(buildErrorVM),
    summary: buildSummaryVM(packages, response.releases.length),
  };
}

function buildPackageIdentityMap(releases: AnalyzeProjectRelease[]): Map<string, PackageIdentity> {
  const out = new Map<string, PackageIdentity>();
  for (const release of releases) {
    out.set(
      release.packageUrl,
      new PackageIdentity(
        release.packageUrl,
        release.packageName,
        release.version,
        release.packageManager,
      ),
    );
  }
  return out;
}

function buildPackageVM(
  release: AnalyzeProjectRelease,
  filter: RiskPredicate,
  identityByPurl: Map<string, PackageIdentity>,
): PackageVM | null {
  const groups = buildGroups(release, filter);
  if (groups.length === 0) return null;
  const riskCount = groups.reduce((n, g) => n + g.risks.length, 0);
  return {
    package: identityByPurl.get(release.packageUrl)!,
    newlyIntroduced: release.newlyIntroduced,
    riskCount,
    filePaths: release.dependencyFilePaths,
    chains: resolveChains(release, identityByPurl),
    groups,
  };
}

function resolveChains(
  release: AnalyzeProjectRelease,
  identityByPurl: Map<string, PackageIdentity>,
): PackageIdentity[][] {
  const resolved: PackageIdentity[][] = [];
  for (const chain of release.dependencyChains) {
    const ids = resolveChain(chain, release, identityByPurl);
    if (ids !== null) resolved.push(ids);
  }
  return resolved.sort((a, b) => a.length - b.length);
}

function resolveChain(
  chain: string[],
  release: AnalyzeProjectRelease,
  identityByPurl: Map<string, PackageIdentity>,
): PackageIdentity[] | null {
  const ids: PackageIdentity[] = [];
  for (const purl of chain) {
    const id = identityByPurl.get(purl);
    if (id === undefined) {
      logger.debug(`Skipping dependency chain for ${release.packageUrl}: unknown purl ${purl}`);
      return null;
    }
    ids.push(id);
  }
  return ids;
}

function buildGroups(release: AnalyzeProjectRelease, filter: RiskPredicate): RiskGroupVM<RiskVM>[] {
  const byType = groupIssuesByType(release.issues);
  const groups: RiskGroupVM<RiskVM>[] = [];
  for (const type of ISSUE_TYPES) {
    const typed = byType.get(type) ?? [];
    if (typed.length === 0) continue;
    const group = buildGroup(type, release, sortBySeverity(typed), filter);
    if (group !== null) groups.push(group);
  }
  return groups;
}

function sortBySeverity(issues: AnalyzeProjectIssue[]): AnalyzeProjectIssue[] {
  return [...issues].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
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
  filter: RiskPredicate,
): MalwareGroupVM | LicenseGroupVM | VulnerabilityGroupVM | null {
  switch (type) {
    case 'MALWARE': {
      const risks = filterRisks(
        issues.map((i) => buildMalwareRisk(release, i)),
        filter,
      );
      return risks.length === 0 ? null : { type, risks };
    }
    case 'PROHIBITED_LICENSE': {
      const risks = filterRisks(
        issues.map((i) => buildLicenseRisk(release, i)),
        filter,
      );
      return risks.length === 0 ? null : { type, risks };
    }
    case 'VULNERABILITY': {
      const survivors = issues
        .map((issue) => ({ issue, risk: buildVulnerabilityRisk(release, issue) }))
        .filter(({ risk }) => filter(risk));
      if (survivors.length === 0) return null;
      return {
        type,
        risks: survivors.map(({ risk }) => risk),
        packageFixes: selectPackageCompleteFixes(survivors.map(({ issue }) => issue)),
      };
    }
  }
}

function filterRisks<T extends RiskVM>(risks: T[], filter: RiskPredicate): T[] {
  return risks.filter(filter);
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

function buildSummaryVM(packages: PackageVM[], packagesScanned: number): SummaryVM {
  const counts = summaryCountsByTypeAndSeverity(packages);
  return {
    packagesScanned,
    totalRisks: packages.reduce((n, p) => n + p.riskCount, 0),
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
  packages: PackageVM[],
): Map<ScaIssueType, Map<SummarySeverity, number>> {
  const validSeverities = new Set<string>(SUMMARY_SEVERITIES);
  const out = new Map<ScaIssueType, Map<SummarySeverity, number>>();
  for (const pkg of packages) {
    for (const group of pkg.groups) {
      let row = out.get(group.type);
      if (!row) {
        row = new Map();
        out.set(group.type, row);
      }
      for (const risk of group.risks) {
        if (!validSeverities.has(risk.severity)) continue;
        const sev = risk.severity as SummarySeverity;
        row.set(sev, (row.get(sev) ?? 0) + 1);
      }
    }
  }
  return out;
}

function effectiveStatus(
  release: Pick<AnalyzeProjectRelease, 'newlyIntroduced'>,
  issue: Pick<AnalyzeProjectIssue, 'status'>,
): string {
  const fallback = release.newlyIntroduced ? 'NEW' : 'OPEN';
  return (issue.status ?? fallback).toUpperCase();
}

function severityRank(severity: string | undefined): number {
  return severity
    ? (SEVERITY_RANK[severity.toUpperCase()] ?? Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;
}
