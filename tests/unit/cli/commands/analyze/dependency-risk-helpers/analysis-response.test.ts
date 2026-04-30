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
  applyStatusFilter,
  sortReleases,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/analysis-response.ts';
import type {
  AnalyzeProjectIssue,
  AnalyzeProjectRelease,
  AnalyzeProjectResponse,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';

function makeResponse(
  releases: AnalyzeProjectRelease[],
  overrides: Partial<Omit<AnalyzeProjectResponse, 'releases'>> = {},
): AnalyzeProjectResponse {
  return { releases, parsedFiles: [], errors: [], ...overrides };
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
    dependencyFilePaths: ['package-lock.json'],
    dependencyChains: [['pkg:npm/lodash@4.17.21']],
    ...overrides,
  };
}

function makeVulnIssue(overrides: Partial<AnalyzeProjectIssue> = {}): AnalyzeProjectIssue {
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

function makeMalwareIssue(overrides: Partial<AnalyzeProjectIssue> = {}): AnalyzeProjectIssue {
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

describe('applyStatusFilter', () => {
  describe.each(['open', 'all'] as const)('with filter=%s', (filter) => {
    it('drops releases that have no issues', () => {
      const response = makeResponse([
        makeRelease({ packageName: 'a', issues: [] }),
        makeRelease({ packageName: 'b', issues: [makeVulnIssue()] }),
      ]);

      const filtered = applyStatusFilter(response, filter);

      expect(filtered.releases.map((r) => r.packageName)).toEqual(['b']);
    });

    it('passes parsedFiles and errors through unchanged', () => {
      const response = makeResponse([], {
        parsedFiles: ['package-lock.json'],
        errors: [{ id: 'e1', code: 'UNKNOWN', path: null, message: 'err' }],
      });

      const filtered = applyStatusFilter(response, filter);

      expect(filtered.parsedFiles).toEqual(['package-lock.json']);
      expect(filtered.errors).toEqual([{ id: 'e1', code: 'UNKNOWN', path: null, message: 'err' }]);
    });
  });

  describe('with filter=open', () => {
    it('drops issues whose status is SAFE, FIXED, or ACCEPT', () => {
      const release = makeRelease({
        packageName: 'foo',
        issues: [
          makeVulnIssue({ key: 'open', status: 'OPEN' }),
          makeVulnIssue({ key: 'safe', status: 'SAFE' }),
          makeVulnIssue({ key: 'fixed', status: 'FIXED' }),
          makeVulnIssue({ key: 'accept', status: 'ACCEPT' }),
          makeVulnIssue({ key: 'confirm', status: 'CONFIRM' }),
        ],
      });

      const filtered = applyStatusFilter(makeResponse([release]), 'open');

      expect(filtered.releases[0].issues.map((i) => i.key)).toEqual(['open', 'confirm']);
    });

    it('treats resolved status case-insensitively', () => {
      const release = makeRelease({
        issues: [
          makeVulnIssue({ key: 'lower-safe', status: 'safe' }),
          makeVulnIssue({ key: 'mixed-fixed', status: 'Fixed' }),
          makeVulnIssue({ key: 'open', status: 'OPEN' }),
        ],
      });

      const filtered = applyStatusFilter(makeResponse([release]), 'open');

      expect(filtered.releases[0].issues.map((i) => i.key)).toEqual(['open']);
    });

    it('drops releases that become issue-less after resolved-status pruning', () => {
      const response = makeResponse([
        makeRelease({
          packageName: 'all-resolved',
          issues: [makeVulnIssue({ status: 'SAFE' }), makeVulnIssue({ status: 'FIXED' })],
        }),
        makeRelease({ packageName: 'still-open', issues: [makeVulnIssue({ status: 'OPEN' })] }),
      ]);

      const filtered = applyStatusFilter(response, 'open');

      expect(filtered.releases.map((r) => r.packageName)).toEqual(['still-open']);
    });
  });

  describe('with filter=all', () => {
    it('keeps resolved issues and their releases', () => {
      const response = makeResponse([
        makeRelease({
          packageName: 'all-resolved',
          issues: [
            makeVulnIssue({ key: 'safe', status: 'SAFE' }),
            makeVulnIssue({ key: 'fixed', status: 'FIXED' }),
          ],
        }),
        makeRelease({ packageName: 'still-open', issues: [makeVulnIssue({ key: 'open' })] }),
      ]);

      const filtered = applyStatusFilter(response, 'all');

      expect(filtered.releases.map((r) => r.packageName)).toEqual(['all-resolved', 'still-open']);
      expect(filtered.releases[0].issues.map((i) => i.key)).toEqual(['safe', 'fixed']);
    });
  });

  it('does not mutate the input response or its releases', () => {
    const release = makeRelease({
      packageName: 'foo',
      issues: [makeVulnIssue({ status: 'SAFE' }), makeVulnIssue({ status: 'OPEN' })],
    });
    const response = makeResponse([release]);
    const issuesBefore = release.issues.length;
    const releasesBefore = response.releases.length;

    applyStatusFilter(response, 'open');

    expect(release.issues.length).toBe(issuesBefore);
    expect(response.releases.length).toBe(releasesBefore);
  });
});

describe('sortReleases', () => {
  it('sorts releases by packageName@version', () => {
    const releases = [
      makeRelease({ packageName: 'zeta', version: '1.0.0', issues: [makeVulnIssue()] }),
      makeRelease({ packageName: 'alpha', version: '2.0.0', issues: [makeVulnIssue()] }),
      makeRelease({ packageName: 'mid', version: '0.0.1', issues: [makeVulnIssue()] }),
    ];

    expect(sortReleases(releases).map((r) => `${r.packageName}@${r.version}`)).toEqual([
      'alpha@2.0.0',
      'mid@0.0.1',
      'zeta@1.0.0',
    ]);
  });

  it('sorts issues within a release by severity rank then type', () => {
    const release = makeRelease({
      issues: [
        makeVulnIssue({ severity: 'LOW', vulnerabilityId: 'CVE-LOW' }),
        makeVulnIssue({ severity: 'BLOCKER', vulnerabilityId: 'CVE-BLOCK' }),
        makeMalwareIssue({ severity: 'BLOCKER' }),
        makeVulnIssue({ severity: 'MEDIUM', vulnerabilityId: 'CVE-MED' }),
      ],
    });

    const [sorted] = sortReleases([release]);

    expect(sorted.issues.map((i) => `${i.severity}:${i.type}`)).toEqual([
      'BLOCKER:MALWARE',
      'BLOCKER:VULNERABILITY',
      'MEDIUM:VULNERABILITY',
      'LOW:VULNERABILITY',
    ]);
  });

  it('uppercases severity when ranking, so lowercase values sort correctly', () => {
    const release = makeRelease({
      issues: [
        makeVulnIssue({ severity: 'low', vulnerabilityId: 'CVE-LOW' }),
        makeVulnIssue({ severity: 'high', vulnerabilityId: 'CVE-HIGH' }),
      ],
    });

    const [sorted] = sortReleases([release]);

    expect(sorted.issues.map((i) => i.vulnerabilityId)).toEqual(['CVE-HIGH', 'CVE-LOW']);
  });

  it('sinks unknown severities to the bottom of the issue list', () => {
    const release = makeRelease({
      issues: [
        makeVulnIssue({ severity: 'CATASTROPHIC', vulnerabilityId: 'CVE-WAT' }),
        makeVulnIssue({ severity: 'HIGH', vulnerabilityId: 'CVE-HIGH' }),
      ],
    });

    const [sorted] = sortReleases([release]);

    expect(sorted.issues.map((i) => i.vulnerabilityId)).toEqual(['CVE-HIGH', 'CVE-WAT']);
  });

  it('does not mutate the input array or its releases', () => {
    const releases = [
      makeRelease({ packageName: 'zeta', issues: [makeVulnIssue()] }),
      makeRelease({ packageName: 'alpha', issues: [makeVulnIssue()] }),
    ];
    const before = releases.map((r) => r.packageName);

    sortReleases(releases);

    expect(releases.map((r) => r.packageName)).toEqual(before);
  });
});
