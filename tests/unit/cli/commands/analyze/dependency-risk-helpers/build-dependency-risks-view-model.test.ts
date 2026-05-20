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

import { buildDependencyRisksViewModel } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/build-dependency-risks-view-model.ts';
import type { DependencyRisksStatusFilter } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/dependency-risks-view-model.ts';
import { buildRiskFilter } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/risk-filter.ts';
import type {
  AnalyzeProjectIssue,
  AnalyzeProjectRelease,
  AnalyzeProjectResponse,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import { countUnresolvedIssues } from '../../../../../../src/cli/commands/analyze/dependency-risks.ts';

function buildVM(response: AnalyzeProjectResponse, filter: DependencyRisksStatusFilter) {
  return buildDependencyRisksViewModel(response, buildRiskFilter(filter));
}

function makeResponse(
  releases: AnalyzeProjectRelease[],
  overrides: Partial<Omit<AnalyzeProjectResponse, 'releases'>> = {},
): AnalyzeProjectResponse {
  return { releases, parsedFiles: [], errors: [], ...overrides };
}

function makeRelease(overrides: Partial<AnalyzeProjectRelease> = {}): AnalyzeProjectRelease {
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

describe('buildDependencyRisksViewModel — status filtering', () => {
  describe.each(['open', 'all'] as const)('with filter=%s', (filter) => {
    it('drops packages that have no issues', () => {
      const response = makeResponse([
        makeRelease({ packageName: 'a', issues: [] }),
        makeRelease({ packageName: 'b', issues: [makeVulnIssue()] }),
      ]);

      const vm = buildVM(response, filter);

      expect(vm.packages.map((p) => p.package.name)).toEqual(['b']);
    });

    it('passes errors through unchanged (sans the legacy id field)', () => {
      const response = makeResponse([], {
        parsedFiles: ['package-lock.json'],
        errors: [{ id: 'e1', code: 'UNKNOWN', path: null, message: 'err' }],
      });

      const vm = buildVM(response, filter);

      expect(vm.errors).toEqual([{ code: 'UNKNOWN', path: null, message: 'err' }]);
    });
  });

  describe('with filter=open', () => {
    it('drops risks whose status is SAFE, FIXED, or ACCEPT', () => {
      const release = makeRelease({
        packageName: 'foo',
        issues: [
          makeVulnIssue({ vulnerabilityId: 'CVE-open', status: 'OPEN' }),
          makeVulnIssue({ vulnerabilityId: 'CVE-safe', status: 'SAFE' }),
          makeVulnIssue({ vulnerabilityId: 'CVE-fixed', status: 'FIXED' }),
          makeVulnIssue({ vulnerabilityId: 'CVE-accept', status: 'ACCEPT' }),
          makeVulnIssue({ vulnerabilityId: 'CVE-confirm', status: 'CONFIRM' }),
        ],
      });

      const vm = buildVM(makeResponse([release]), 'open');

      const group = vm.packages[0].groups[0];
      expect(group.type).toBe('VULNERABILITY');
      const remaining = (group.risks as { status: string }[]).map((r) => r.status);
      expect(remaining).toEqual(['OPEN', 'CONFIRM']);
    });

    it('treats resolved status case-insensitively', () => {
      const release = makeRelease({
        issues: [
          makeVulnIssue({ vulnerabilityId: 'CVE-lower-safe', status: 'safe' }),
          makeVulnIssue({ vulnerabilityId: 'CVE-mixed-fixed', status: 'Fixed' }),
          makeVulnIssue({ vulnerabilityId: 'CVE-open', status: 'OPEN' }),
        ],
      });

      const vm = buildVM(makeResponse([release]), 'open');

      const group = vm.packages[0].groups[0];
      expect((group.risks as { status: string }[]).map((r) => r.status)).toEqual(['OPEN']);
    });

    it('drops packages that become risk-less after resolved-status pruning', () => {
      const response = makeResponse([
        makeRelease({
          packageName: 'all-resolved',
          issues: [makeVulnIssue({ status: 'SAFE' }), makeVulnIssue({ status: 'FIXED' })],
        }),
        makeRelease({ packageName: 'still-open', issues: [makeVulnIssue({ status: 'OPEN' })] }),
      ]);

      const vm = buildVM(response, 'open');

      expect(vm.packages.map((p) => p.package.name)).toEqual(['still-open']);
    });
  });

  describe('with filter=all', () => {
    it('keeps resolved risks and their packages', () => {
      const response = makeResponse([
        makeRelease({
          packageName: 'all-resolved',
          issues: [
            makeVulnIssue({ vulnerabilityId: 'CVE-safe', status: 'SAFE' }),
            makeVulnIssue({ vulnerabilityId: 'CVE-fixed', status: 'FIXED' }),
          ],
        }),
        makeRelease({
          packageName: 'still-open',
          issues: [makeVulnIssue({ vulnerabilityId: 'CVE-open' })],
        }),
      ]);

      const vm = buildVM(response, 'all');

      expect(vm.packages.map((p) => p.package.name)).toEqual(['all-resolved', 'still-open']);
      const group = vm.packages[0].groups[0];
      expect((group.risks as { status: string }[]).map((r) => r.status)).toEqual(['SAFE', 'FIXED']);
    });
  });

  describe('with filter=new', () => {
    it("keeps risks whose explicit status is 'NEW'", () => {
      const release = makeRelease({
        issues: [
          makeVulnIssue({ vulnerabilityId: 'CVE-new', status: 'NEW' }),
          makeVulnIssue({ vulnerabilityId: 'CVE-open', status: 'OPEN' }),
        ],
      });

      const vm = buildVM(makeResponse([release]), 'new');

      const group = vm.packages[0].groups[0];
      expect((group.risks as { status: string }[]).map((r) => r.status)).toEqual(['NEW']);
    });

    it('keeps null-status risks when their release is newlyIntroduced (status synthesized as NEW)', () => {
      const release = makeRelease({
        newlyIntroduced: true,
        issues: [
          makeVulnIssue({ vulnerabilityId: 'CVE-null', status: null }),
          makeVulnIssue({ vulnerabilityId: 'CVE-open', status: 'OPEN' }),
        ],
      });

      const vm = buildVM(makeResponse([release]), 'new');

      const group = vm.packages[0].groups[0];
      expect((group.risks as { status: string }[]).map((r) => r.status)).toEqual(['NEW']);
    });

    it('drops null-status risks when their release is not newlyIntroduced', () => {
      const release = makeRelease({
        newlyIntroduced: false,
        issues: [makeVulnIssue({ status: null })],
      });

      const vm = buildVM(makeResponse([release]), 'new');

      expect(vm.packages).toEqual([]);
    });

    it('drops resolved and open risks even inside a newlyIntroduced release', () => {
      const release = makeRelease({
        newlyIntroduced: true,
        issues: [
          makeVulnIssue({ status: 'SAFE' }),
          makeVulnIssue({ status: 'FIXED' }),
          makeVulnIssue({ status: 'ACCEPT' }),
          makeVulnIssue({ status: 'OPEN' }),
          makeVulnIssue({ status: 'CONFIRM' }),
        ],
      });

      const vm = buildVM(makeResponse([release]), 'new');

      expect(vm.packages).toEqual([]);
    });

    it('drops packages that become risk-less after pruning to new', () => {
      const response = makeResponse([
        makeRelease({ packageName: 'all-open', issues: [makeVulnIssue({ status: 'OPEN' })] }),
        makeRelease({ packageName: 'has-new', issues: [makeVulnIssue({ status: 'NEW' })] }),
      ]);

      const vm = buildVM(response, 'new');

      expect(vm.packages.map((p) => p.package.name)).toEqual(['has-new']);
    });

    it("treats status case-insensitively (e.g. 'new')", () => {
      const release = makeRelease({
        issues: [makeVulnIssue({ status: 'new' })],
      });

      const vm = buildVM(makeResponse([release]), 'new');

      const group = vm.packages[0].groups[0];
      expect((group.risks as { status: string }[]).map((r) => r.status)).toEqual(['NEW']);
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

    buildVM(response, 'open');

    expect(release.issues.length).toBe(issuesBefore);
    expect(response.releases.length).toBe(releasesBefore);
  });

  it('summary.packagesScanned is the full pre-filter release count', () => {
    const response = makeResponse([
      makeRelease({ packageName: 'a', issues: [makeVulnIssue({ status: 'SAFE' })] }),
      makeRelease({ packageName: 'b', issues: [makeVulnIssue({ status: 'OPEN' })] }),
      makeRelease({ packageName: 'c', issues: [] }),
    ]);

    const vm = buildVM(response, 'open');

    expect(vm.summary.packagesScanned).toBe(3);
    expect(vm.packages.map((p) => p.package.name)).toEqual(['b']);
  });

  it('summary.totalRisks reflects the post-filter set', () => {
    const response = makeResponse([
      makeRelease({
        issues: [makeVulnIssue({ status: 'OPEN' }), makeVulnIssue({ status: 'SAFE' })],
      }),
    ]);

    expect(buildVM(response, 'open').summary.totalRisks).toBe(1);
    expect(buildVM(response, 'all').summary.totalRisks).toBe(2);
  });
});

describe('buildDependencyRisksViewModel — ordering', () => {
  it('sorts packages by name@version', () => {
    const response = makeResponse([
      makeRelease({ packageName: 'zeta', version: '1.0.0', issues: [makeVulnIssue()] }),
      makeRelease({ packageName: 'alpha', version: '2.0.0', issues: [makeVulnIssue()] }),
      makeRelease({ packageName: 'mid', version: '0.0.1', issues: [makeVulnIssue()] }),
    ]);

    const vm = buildVM(response, 'all');

    expect(vm.packages.map((p) => `${p.package.name}@${p.package.version}`)).toEqual([
      'alpha@2.0.0',
      'mid@0.0.1',
      'zeta@1.0.0',
    ]);
  });

  it('orders groups MALWARE → PROHIBITED_LICENSE → VULNERABILITY', () => {
    const release = makeRelease({
      issues: [
        makeVulnIssue({ severity: 'BLOCKER' }),
        makeMalwareIssue({ severity: 'LOW' }),
        {
          key: 'lic',
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
        },
      ],
    });

    const vm = buildVM(makeResponse([release]), 'all');

    expect(vm.packages[0].groups.map((g) => g.type)).toEqual([
      'MALWARE',
      'PROHIBITED_LICENSE',
      'VULNERABILITY',
    ]);
  });

  it('sorts risks within a group by severity (BLOCKER → INFO)', () => {
    const release = makeRelease({
      issues: [
        makeVulnIssue({ severity: 'LOW', vulnerabilityId: 'CVE-LOW' }),
        makeVulnIssue({ severity: 'BLOCKER', vulnerabilityId: 'CVE-BLOCK' }),
        makeVulnIssue({ severity: 'MEDIUM', vulnerabilityId: 'CVE-MED' }),
      ],
    });

    const vm = buildVM(makeResponse([release]), 'all');

    const group = vm.packages[0].groups[0];
    expect((group.risks as { severity: string }[]).map((r) => r.severity)).toEqual([
      'BLOCKER',
      'MEDIUM',
      'LOW',
    ]);
  });

  it('uppercases severity when ranking, so lowercase input sorts correctly', () => {
    const release = makeRelease({
      issues: [
        makeVulnIssue({ severity: 'low', vulnerabilityId: 'CVE-LOW' }),
        makeVulnIssue({ severity: 'high', vulnerabilityId: 'CVE-HIGH' }),
      ],
    });

    const vm = buildVM(makeResponse([release]), 'all');

    const group = vm.packages[0].groups[0];
    expect((group.risks as { severity: string }[]).map((r) => r.severity)).toEqual(['HIGH', 'LOW']);
  });

  it('sinks unknown severities to the bottom of a group', () => {
    const release = makeRelease({
      issues: [
        makeVulnIssue({ severity: 'CATASTROPHIC', vulnerabilityId: 'CVE-WAT' }),
        makeVulnIssue({ severity: 'HIGH', vulnerabilityId: 'CVE-HIGH' }),
      ],
    });

    const vm = buildVM(makeResponse([release]), 'all');

    const group = vm.packages[0].groups[0];
    expect(
      (group.risks as unknown as { vulnerabilityId: string }[]).map((r) => r.vulnerabilityId),
    ).toEqual(['CVE-HIGH', 'CVE-WAT']);
  });
});

describe('buildDependencyRisksViewModel — effective status', () => {
  it('returns the explicit status uppercased', () => {
    const vm = buildVM(
      makeResponse([makeRelease({ issues: [makeVulnIssue({ status: 'open' })] })]),
      'all',
    );

    expect((vm.packages[0].groups[0].risks[0] as { status: string }).status).toBe('OPEN');
  });

  it('explicit status overrides the newlyIntroduced fallback', () => {
    const vm = buildVM(
      makeResponse([
        makeRelease({ newlyIntroduced: true, issues: [makeVulnIssue({ status: 'OPEN' })] }),
      ]),
      'all',
    );

    expect((vm.packages[0].groups[0].risks[0] as { status: string }).status).toBe('OPEN');
  });

  it("synthesizes 'NEW' for a null-status risk when the release is newlyIntroduced", () => {
    const vm = buildVM(
      makeResponse([
        makeRelease({ newlyIntroduced: true, issues: [makeVulnIssue({ status: null })] }),
      ]),
      'all',
    );

    expect((vm.packages[0].groups[0].risks[0] as { status: string }).status).toBe('NEW');
  });

  it("falls back to 'OPEN' for a null-status risk when the release is not newlyIntroduced", () => {
    const vm = buildVM(
      makeResponse([
        makeRelease({ newlyIntroduced: false, issues: [makeVulnIssue({ status: null })] }),
      ]),
      'all',
    );

    expect((vm.packages[0].groups[0].risks[0] as { status: string }).status).toBe('OPEN');
  });
});

describe('countUnresolvedIssues', () => {
  it('counts only unresolved risks across all packages', () => {
    const vm = buildVM(
      makeResponse([
        makeRelease({
          issues: [
            makeVulnIssue({ status: 'OPEN' }),
            makeVulnIssue({ status: 'NEW' }),
            makeVulnIssue({ status: 'SAFE' }),
            makeVulnIssue({ status: 'FIXED' }),
            makeVulnIssue({ status: 'ACCEPT' }),
            makeVulnIssue({ status: 'CONFIRM' }),
          ],
        }),
      ]),
      'all',
    );

    expect(countUnresolvedIssues(vm)).toBe(3);
  });

  it("returns the count of new risks when applied to the 'new' filter result", () => {
    const vm = buildVM(
      makeResponse([
        makeRelease({
          issues: [
            makeVulnIssue({ status: 'NEW' }),
            makeVulnIssue({ status: 'NEW' }),
            makeVulnIssue({ status: 'OPEN' }),
            makeVulnIssue({ status: 'SAFE' }),
          ],
        }),
      ]),
      'new',
    );

    expect(countUnresolvedIssues(vm)).toBe(2);
  });
});
