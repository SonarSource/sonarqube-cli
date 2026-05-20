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

import type { ScaIssueType, VersionOptionDescriptionCode } from './sca-scanner.ts';

export type DependencyRisksStatusFilter = 'all' | 'open' | 'new';

export interface DependencyRisksViewModel {
  packages: PackageVM[];
  errors: ErrorVM[];
  summary: SummaryVM;
}

export class PackageIdentity {
  constructor(
    readonly purl: string,
    readonly name: string,
    readonly version: string,
    readonly packageManager: string,
  ) {}

  label(): string {
    return this.version ? `${this.name}@${this.version}` : this.name;
  }

  compareTo(other: PackageIdentity): number {
    return this.purl.localeCompare(other.purl);
  }

  toJSON(): string {
    return this.purl;
  }
}

export interface PackageVM {
  package: PackageIdentity;
  newlyIntroduced: boolean;
  riskCount: number;
  filePaths: string[];
  chains: PackageIdentity[][];
  groups: RiskGroupVM<RiskVM>[];
}

export interface RiskVM {
  severity: string;
  status: string;
}

export interface RiskGroupVM<T extends RiskVM> {
  type: ScaIssueType;
  risks: T[];
}

export type MalwareRiskVM = RiskVM;

export interface LicenseRiskVM extends RiskVM {
  spdxLicenseId: string | null;
  releaseLicenseExpression: string | null;
}

export interface VulnerabilityRiskVM extends RiskVM {
  cvssScore: string | null;
  vulnerabilityId: string;
  partialFixes: FixVersionVM[];
}

export interface MalwareGroupVM extends RiskGroupVM<MalwareRiskVM> {
  type: 'MALWARE';
}

export interface LicenseGroupVM extends RiskGroupVM<LicenseRiskVM> {
  type: 'PROHIBITED_LICENSE';
}

export interface VulnerabilityGroupVM extends RiskGroupVM<VulnerabilityRiskVM> {
  type: 'VULNERABILITY';
  packageFixes: FixVersionVM[];
}

export interface FixVersionVM {
  version: string;
  descriptionCode: VersionOptionDescriptionCode;
  vulnerabilityIds: string[];
}

export interface ErrorVM {
  code: string;
  path: string | null;
  message: string;
}

export interface SummaryVM {
  packagesScanned: number;
  totalRisks: number;
  rows: SummaryRowVM[];
}

export interface SummaryRowVM {
  type: ScaIssueType;
  counts: SeverityCountVM[];
}

export type SummarySeverity = 'BLOCKER' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface SeverityCountVM {
  severity: SummarySeverity;
  count: number;
}
