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
  VersionOption,
} from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';

export function mockScaResponse(
  releases: AnalyzeProjectRelease[],
  overrides: Partial<Omit<AnalyzeProjectResponse, 'releases'>> = {},
): AnalyzeProjectResponse {
  return { releases, parsedFiles: [], errors: [], ...overrides };
}

export function mockScaRelease(
  overrides: Partial<AnalyzeProjectRelease> = {},
): AnalyzeProjectRelease {
  const packageName = overrides.packageName ?? 'lodash';
  const version = overrides.version ?? '4.17.21';
  return {
    key: `release-${packageName}`,
    packageUrl: `pkg:npm/${packageName}@${version}`,
    packageManager: 'npm',
    packageName,
    version,
    licenseExpression: null,
    known: true,
    knownPackage: true,
    newlyIntroduced: false,
    issues: [],
    dependencyFilePaths: ['package-lock.json'],
    dependencyChains: [[`pkg:npm/${packageName}@${version}`]],
    ...overrides,
  };
}

export function mockVulnerabilityRisk(
  overrides: Partial<AnalyzeProjectIssue> = {},
): AnalyzeProjectIssue {
  return {
    key: 'issue-cve-1',
    severity: 'HIGH',
    showIncreasedSeverityWarning: null,
    type: 'VULNERABILITY',
    quality: 'SECURITY',
    status: 'OPEN',
    vulnerabilityId: 'CVE-2024-0001',
    cweIds: null,
    cvssScore: null,
    spdxLicenseId: null,
    versionOptions: null,
    ...overrides,
  };
}

export function mockMalwareRisk(overrides: Partial<AnalyzeProjectIssue> = {}): AnalyzeProjectIssue {
  return {
    key: 'issue-malware',
    severity: 'BLOCKER',
    showIncreasedSeverityWarning: null,
    type: 'MALWARE',
    quality: 'SECURITY',
    status: 'OPEN',
    vulnerabilityId: null,
    cweIds: null,
    cvssScore: null,
    spdxLicenseId: null,
    versionOptions: null,
    ...overrides,
  };
}

export function mockLicenseRisk(overrides: Partial<AnalyzeProjectIssue> = {}): AnalyzeProjectIssue {
  return {
    key: 'issue-license',
    severity: 'HIGH',
    showIncreasedSeverityWarning: null,
    type: 'PROHIBITED_LICENSE',
    quality: 'MAINTAINABILITY',
    status: 'OPEN',
    vulnerabilityId: null,
    cweIds: null,
    cvssScore: null,
    spdxLicenseId: 'GPL-3.0',
    versionOptions: null,
    ...overrides,
  };
}

export function mockVersionOption(overrides: Partial<VersionOption> = {}): VersionOption {
  return {
    version: '1.0.0',
    vulnerabilityIds: [],
    prerelease: false,
    fixLevel: 'COMPLETE',
    descriptionCode: 'LATEST_STABLE',
    ...overrides,
  };
}
