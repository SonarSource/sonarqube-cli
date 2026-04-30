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

import type {
  AnalyzeProjectIssue,
  AnalyzeProjectRelease,
  AnalyzeProjectResponse,
  ScaIssueType,
  SoftwareQuality,
} from './sca-scanner.ts';

export type DependencyRiskType = ScaIssueType;
export type DependencyRiskSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKER';
export type { SoftwareQuality } from './sca-scanner.ts';
export type DependencyRiskStatus = 'OPEN' | 'CONFIRM' | 'ACCEPT' | 'SAFE' | 'FIXED';

export interface DependencyRisk {
  packageName: string;
  releaseKey: string;
  issueKey?: string;
  type: DependencyRiskType;
  severity: DependencyRiskSeverity;
  quality: SoftwareQuality;
  status: DependencyRiskStatus;
  newlyIntroduced: boolean;
  dependencyFilePaths: string[];
  dependencyChains: string[][];
  licenseExpression?: string;
  vulnerabilityId?: string;
  cvssScore?: string;
  cweIds?: string[];
}

const SEVERITIES: readonly DependencyRiskSeverity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'BLOCKER'];

const SEVERITY_RANK: Record<DependencyRiskSeverity, number> = {
  BLOCKER: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

export function sortDependencyRisks(risks: DependencyRisk[]): DependencyRisk[] {
  return [...risks].sort((a, b) => {
    const pkg = a.packageName.localeCompare(b.packageName);
    if (pkg !== 0) return pkg;
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return a.type.localeCompare(b.type);
  });
}

export function toDependencyRisks(response: AnalyzeProjectResponse): DependencyRisk[] {
  return response.releases.flatMap((release) =>
    release.issues.map((issue) => toDependencyRisk(release, issue)),
  );
}

function toDependencyRisk(
  release: AnalyzeProjectRelease,
  issue: AnalyzeProjectIssue,
): DependencyRisk {
  const risk: DependencyRisk = {
    packageName: `${release.packageName}@${release.version}`,
    releaseKey: release.key,
    issueKey: issue.key,
    type: issue.type,
    severity: normalizeSeverity(issue.severity),
    quality: issue.quality,
    status: (issue.status as DependencyRiskStatus | undefined) ?? 'OPEN',
    newlyIntroduced: release.newlyIntroduced,
    dependencyFilePaths: release.dependencyFilePaths,
    dependencyChains: release.dependencyChains,
  };
  if (issue.type === 'VULNERABILITY') {
    risk.vulnerabilityId = issue.vulnerabilityId;
    risk.cvssScore = issue.cvssScore;
    risk.cweIds = issue.cweIds;
  } else if (issue.type === 'PROHIBITED_LICENSE') {
    risk.licenseExpression = issue.spdxLicenseId ?? release.licenseExpression ?? undefined;
  }
  return risk;
}

function normalizeSeverity(raw: string): DependencyRiskSeverity {
  const upper = raw.toUpperCase();
  return (SEVERITIES as readonly string[]).includes(upper)
    ? (upper as DependencyRiskSeverity)
    : 'INFO';
}
