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
  ScaPackage,
  ScaPackageInfoResponse,
  ScaVersionFix,
  ScaVulnerability,
} from './sca-scanner.ts';

export type DependencyRiskType = 'VULNERABILITY' | 'PROHIBITED_LICENSE' | 'MALWARE';
export type DependencyRiskSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKER';
export type SoftwareQuality = 'MAINTAINABILITY' | 'RELIABILITY' | 'SECURITY';
export type DependencyRiskStatus = 'OPEN' | 'CONFIRM' | 'ACCEPT' | 'SAFE' | 'FIXED';

export interface DependencyRisk {
  packageName: string;
  type: DependencyRiskType;
  severity: DependencyRiskSeverity;
  quality: SoftwareQuality;
  status: DependencyRiskStatus;
  dependencyFilePaths: string[];
  dependencyChains: string[][];
  licenseExpression?: string;
  vulnerabilityId?: string;
  cvssScore?: number;
  cweIds?: string[];
  publishedOn?: string;
  fixedVersions?: ScaVersionFix[] | null;
  unaffectedVersions?: string[] | null;
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

export function toDependencyRisks(response: ScaPackageInfoResponse): DependencyRisk[] {
  const risks: DependencyRisk[] = [];
  for (const pkg of response.packages) {
    if (pkg.malicious) {
      risks.push(malwareRisk(pkg));
    }
    if (pkg.license?.allowed === false) {
      risks.push(prohibitedLicenseRisk(pkg));
    }
    for (const vuln of pkg.vulnerabilities ?? []) {
      if (vuln.withdrawn) {
        continue;
      }
      risks.push(vulnerabilityRisk(pkg, vuln));
    }
  }
  return risks;
}

function malwareRisk(pkg: ScaPackage): DependencyRisk {
  return {
    packageName: pkg.purl,
    type: 'MALWARE',
    severity: 'BLOCKER',
    quality: 'SECURITY',
    status: 'OPEN',
    dependencyFilePaths: pkg.dependencyFilePaths,
    dependencyChains: pkg.dependencyChains,
  };
}

function prohibitedLicenseRisk(pkg: ScaPackage): DependencyRisk {
  return {
    packageName: pkg.purl,
    type: 'PROHIBITED_LICENSE',
    severity: 'HIGH',
    quality: 'MAINTAINABILITY',
    status: 'OPEN',
    dependencyFilePaths: pkg.dependencyFilePaths,
    dependencyChains: pkg.dependencyChains,
    licenseExpression: pkg.license?.expression,
  };
}

function vulnerabilityRisk(pkg: ScaPackage, vuln: ScaVulnerability): DependencyRisk {
  return {
    packageName: pkg.purl,
    type: 'VULNERABILITY',
    severity: normalizeSeverity(vuln.riskSeverity),
    quality: 'SECURITY',
    status: 'OPEN',
    dependencyFilePaths: pkg.dependencyFilePaths,
    dependencyChains: pkg.dependencyChains,
    vulnerabilityId: vuln.id,
    cvssScore: vuln.cvssScore,
    cweIds: vuln.cweIds,
    publishedOn: vuln.publishedOn,
    fixedVersions: vuln.fixedVersions,
    unaffectedVersions: vuln.unaffectedVersions,
  };
}

function normalizeSeverity(raw: string): DependencyRiskSeverity {
  const upper = raw.toUpperCase();
  return (SEVERITIES as readonly string[]).includes(upper)
    ? (upper as DependencyRiskSeverity)
    : 'INFO';
}
