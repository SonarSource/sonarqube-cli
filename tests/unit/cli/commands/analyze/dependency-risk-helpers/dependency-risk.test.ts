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

import { toDependencyRisks } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/dependency-risk.ts';
import type {
  AnalyzeProjectIssue,
  AnalyzeProjectRelease,
  AnalyzeProjectResponse,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';

const DEFAULT_FILE_PATHS = ['package-lock.json'];
const DEFAULT_CHAINS = [['pkg:npm/lodash@4.17.21']];

function makeResponse(releases: AnalyzeProjectRelease[]): AnalyzeProjectResponse {
  return { releases, parsedFiles: [], errors: [] };
}

function makeRelease(overrides: Partial<AnalyzeProjectRelease> = {}): AnalyzeProjectRelease {
  return {
    key: 'release-lodash',
    packageUrl: 'pkg:npm/lodash@4.17.21',
    packageManager: 'npm',
    packageName: 'lodash',
    version: '4.17.21',
    licenseExpression: null,
    known: true,
    knownPackage: true,
    newlyIntroduced: false,
    issues: [],
    dependencyFilePaths: DEFAULT_FILE_PATHS,
    dependencyChains: DEFAULT_CHAINS,
    ...overrides,
  };
}

function makeVulnIssue(overrides: Partial<AnalyzeProjectIssue> = {}): AnalyzeProjectIssue {
  return {
    key: 'issue-cve-1',
    severity: 'HIGH',
    type: 'VULNERABILITY',
    quality: 'SECURITY',
    status: 'OPEN',
    vulnerabilityId: 'CVE-2024-0001',
    cweIds: ['CWE-79'],
    cvssScore: '7.5',
    ...overrides,
  };
}

function makeMalwareIssue(overrides: Partial<AnalyzeProjectIssue> = {}): AnalyzeProjectIssue {
  return {
    key: 'issue-malware',
    severity: 'BLOCKER',
    type: 'MALWARE',
    quality: 'SECURITY',
    status: 'OPEN',
    ...overrides,
  };
}

function makeLicenseIssue(overrides: Partial<AnalyzeProjectIssue> = {}): AnalyzeProjectIssue {
  return {
    key: 'issue-license',
    severity: 'HIGH',
    type: 'PROHIBITED_LICENSE',
    quality: 'MAINTAINABILITY',
    status: 'OPEN',
    spdxLicenseId: 'GPL-3.0',
    ...overrides,
  };
}

describe('toDependencyRisks', () => {
  it('returns empty array when there are no releases', () => {
    expect(toDependencyRisks(makeResponse([]))).toEqual([]);
  });

  it('returns empty array when releases have no issues', () => {
    expect(toDependencyRisks(makeResponse([makeRelease({ issues: [] })]))).toEqual([]);
  });

  it('emits one VULNERABILITY risk per vulnerability issue with id and cvssScore copied', () => {
    const release = makeRelease({
      key: 'release-foo',
      packageName: 'foo',
      version: '1.0.0',
      dependencyFilePaths: ['package-lock.json'],
      dependencyChains: [['pkg:npm/foo@1.0.0']],
      issues: [
        makeVulnIssue({
          key: 'issue-cve-1',
          vulnerabilityId: 'CVE-1',
          cvssScore: '9.8',
          severity: 'BLOCKER',
          cweIds: ['CWE-78'],
        }),
      ],
    });

    const risks = toDependencyRisks(makeResponse([release]));

    expect(risks).toEqual([
      {
        packageName: 'foo@1.0.0',
        releaseKey: 'release-foo',
        issueKey: 'issue-cve-1',
        type: 'VULNERABILITY',
        severity: 'BLOCKER',
        quality: 'SECURITY',
        status: 'OPEN',
        newlyIntroduced: false,
        dependencyFilePaths: ['package-lock.json'],
        dependencyChains: [['pkg:npm/foo@1.0.0']],
        vulnerabilityId: 'CVE-1',
        cvssScore: '9.8',
        cweIds: ['CWE-78'],
      },
    ]);
  });

  it('emits one risk per issue when there are multiple', () => {
    const release = makeRelease({
      key: 'release-foo',
      packageName: 'foo',
      version: '1.0.0',
      issues: [
        makeVulnIssue({ vulnerabilityId: 'CVE-1', severity: 'LOW' }),
        makeVulnIssue({ vulnerabilityId: 'CVE-2', severity: 'HIGH' }),
        makeVulnIssue({ vulnerabilityId: 'CVE-3', severity: 'MEDIUM' }),
      ],
    });

    const risks = toDependencyRisks(makeResponse([release]));

    expect(risks).toHaveLength(3);
    expect(risks.map((r) => r.vulnerabilityId)).toEqual(['CVE-1', 'CVE-2', 'CVE-3']);
    expect(risks.map((r) => r.severity)).toEqual(['LOW', 'HIGH', 'MEDIUM']);
    for (const risk of risks) {
      expect(risk.packageName).toBe('foo@1.0.0');
      expect(risk.type).toBe('VULNERABILITY');
    }
  });

  it('emits a MALWARE risk passing through severity and quality from the issue', () => {
    const release = makeRelease({
      key: 'release-evil',
      packageName: 'evil',
      version: '0.0.1',
      dependencyFilePaths: ['package-lock.json'],
      dependencyChains: [['pkg:npm/evil@0.0.1']],
      issues: [makeMalwareIssue()],
    });

    const risks = toDependencyRisks(makeResponse([release]));

    expect(risks).toEqual([
      {
        packageName: 'evil@0.0.1',
        releaseKey: 'release-evil',
        issueKey: 'issue-malware',
        type: 'MALWARE',
        severity: 'BLOCKER',
        quality: 'SECURITY',
        status: 'OPEN',
        newlyIntroduced: false,
        dependencyFilePaths: ['package-lock.json'],
        dependencyChains: [['pkg:npm/evil@0.0.1']],
      },
    ]);
  });

  it('emits a PROHIBITED_LICENSE risk preferring spdxLicenseId, falling back to release license', () => {
    const release = makeRelease({
      key: 'release-gpl',
      packageName: 'gpl-thing',
      version: '2.0.0',
      licenseExpression: 'GPL-3.0',
      dependencyFilePaths: ['package-lock.json'],
      dependencyChains: [['pkg:npm/gpl-thing@2.0.0']],
      issues: [makeLicenseIssue({ spdxLicenseId: 'GPL-3.0' })],
    });

    const risks = toDependencyRisks(makeResponse([release]));

    expect(risks[0]).toMatchObject({
      packageName: 'gpl-thing@2.0.0',
      type: 'PROHIBITED_LICENSE',
      severity: 'HIGH',
      quality: 'MAINTAINABILITY',
      status: 'OPEN',
      licenseExpression: 'GPL-3.0',
    });
  });

  it('falls back to release.licenseExpression when spdxLicenseId is missing', () => {
    const release = makeRelease({
      licenseExpression: 'AGPL-3.0',
      issues: [makeLicenseIssue({ spdxLicenseId: undefined })],
    });

    const risks = toDependencyRisks(makeResponse([release]));

    expect(risks[0].licenseExpression).toBe('AGPL-3.0');
  });

  it('emits malware, license, and vulnerability risks in issue order for a release with all three', () => {
    const release = makeRelease({
      packageName: 'triple-trouble',
      version: '1.2.3',
      licenseExpression: 'AGPL-3.0',
      issues: [
        makeMalwareIssue(),
        makeLicenseIssue({ spdxLicenseId: 'AGPL-3.0' }),
        makeVulnIssue({ vulnerabilityId: 'CVE-A', severity: 'MEDIUM' }),
        makeVulnIssue({ vulnerabilityId: 'CVE-B', severity: 'LOW' }),
      ],
    });

    const risks = toDependencyRisks(makeResponse([release]));

    expect(risks.map((r) => r.type)).toEqual([
      'MALWARE',
      'PROHIBITED_LICENSE',
      'VULNERABILITY',
      'VULNERABILITY',
    ]);
    expect(risks.map((r) => r.packageName)).toEqual([
      'triple-trouble@1.2.3',
      'triple-trouble@1.2.3',
      'triple-trouble@1.2.3',
      'triple-trouble@1.2.3',
    ]);
  });

  it('normalizes lowercase severity values to the enum', () => {
    const release = makeRelease({
      issues: [makeVulnIssue({ severity: 'high' })],
    });

    expect(toDependencyRisks(makeResponse([release]))[0].severity).toBe('HIGH');
  });

  it('falls back to INFO for unknown severity values', () => {
    const release = makeRelease({
      issues: [makeVulnIssue({ severity: 'CATASTROPHIC' })],
    });

    expect(toDependencyRisks(makeResponse([release]))[0].severity).toBe('INFO');
  });

  it('defaults status to OPEN when the issue has no status', () => {
    const release = makeRelease({
      issues: [makeVulnIssue({ status: undefined })],
    });

    expect(toDependencyRisks(makeResponse([release]))[0].status).toBe('OPEN');
  });

  it('passes through scanner-provided status when present', () => {
    const release = makeRelease({
      issues: [makeVulnIssue({ status: 'ACCEPT' })],
    });

    expect(toDependencyRisks(makeResponse([release]))[0].status).toBe('ACCEPT');
  });

  it('propagates newlyIntroduced from the release to every risk it produces', () => {
    const release = makeRelease({
      newlyIntroduced: true,
      issues: [makeVulnIssue(), makeMalwareIssue()],
    });

    const risks = toDependencyRisks(makeResponse([release]));
    expect(risks.map((r) => r.newlyIntroduced)).toEqual([true, true]);
  });

  it('does not put vulnerability-only fields on malware or license risks', () => {
    const release = makeRelease({
      issues: [makeMalwareIssue(), makeLicenseIssue()],
    });

    const risks = toDependencyRisks(makeResponse([release]));

    for (const risk of risks) {
      expect(risk.vulnerabilityId).toBeUndefined();
      expect(risk.cvssScore).toBeUndefined();
      expect(risk.cweIds).toBeUndefined();
    }
  });

  it('does not put licenseExpression on malware or vulnerability risks', () => {
    const release = makeRelease({
      licenseExpression: 'GPL-3.0',
      issues: [makeMalwareIssue(), makeVulnIssue()],
    });

    const risks = toDependencyRisks(makeResponse([release]));
    const malware = risks.find((r) => r.type === 'MALWARE');
    const vuln = risks.find((r) => r.type === 'VULNERABILITY');

    expect(malware?.licenseExpression).toBeUndefined();
    expect(vuln?.licenseExpression).toBeUndefined();
  });
});
