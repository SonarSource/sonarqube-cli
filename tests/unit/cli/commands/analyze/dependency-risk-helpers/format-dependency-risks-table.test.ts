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

import { formatDependencyRisksTable } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/format-dependency-risks-table.ts';
import type {
  AnalysisErrorResource,
  AnalyzeProjectIssue,
  AnalyzeProjectRelease,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';

function makeRelease(overrides: Partial<AnalyzeProjectRelease> = {}): AnalyzeProjectRelease {
  return {
    key: 'release-foo',
    packageUrl: 'pkg:npm/foo@1.0.0',
    packageManager: 'npm',
    packageName: 'foo',
    version: '1.0.0',
    licenseExpression: null,
    known: true,
    knownPackage: true,
    newlyIntroduced: false,
    issues: [],
    dependencyFilePaths: ['package-lock.json'],
    dependencyChains: [['pkg:npm/foo@1.0.0']],
    ...overrides,
  };
}

function makeVulnIssue(overrides: Partial<AnalyzeProjectIssue> = {}): AnalyzeProjectIssue {
  return {
    key: 'issue-cve',
    severity: 'HIGH',
    showIncreasedSeverityWarning: null,
    type: 'VULNERABILITY',
    quality: 'SECURITY',
    status: 'OPEN',
    vulnerabilityId: 'CVE-1',
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

function makeLicenseIssue(overrides: Partial<AnalyzeProjectIssue> = {}): AnalyzeProjectIssue {
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

function lineWith(out: string, marker: string): string {
  const line = out.split('\n').find((l) => l.includes(marker));
  if (!line) {
    throw new Error(`No line containing "${marker}" in:\n${out}`);
  }
  return line;
}

function fmt(
  releases: AnalyzeProjectRelease[],
  packagesScanned?: number,
  errors: AnalysisErrorResource[] = [],
): string {
  const total = packagesScanned ?? releases.length;
  const padding = Math.max(0, total - releases.length);
  const allReleases: AnalyzeProjectRelease[] = [
    ...releases,
    ...Array.from({ length: padding }, (_, i) =>
      makeRelease({
        key: `pad-${i}`,
        packageName: `pad${i}`,
        packageUrl: `pkg:pad/pad${i}@0.0.0`,
        version: '0.0.0',
        issues: [],
      }),
    ),
  ];
  return formatDependencyRisksTable({ releases, parsedFiles: [], errors }, allReleases);
}

describe('formatDependencyRisksTable', () => {
  it('emits a clean-scan message when there are no risks and no errors', () => {
    expect(fmt([], 0, [])).toBe(
      'Scan Summary: 0 dependencies checked. 0 risks found\nNo dependency risks found.',
    );
  });

  it('omits the clean-scan message when there are no risks but errors are present', () => {
    const out = fmt([], 0, [
      { id: 'e1', code: 'NO_DEPENDENCIES_FOUND', path: null, message: 'no deps' },
    ]);
    expect(out).not.toContain('No dependency risks found.');
    expect(out).toContain('Errors:');
  });

  it('counts total risks across all releases in the summary line', () => {
    const out = fmt(
      [
        makeRelease({ packageName: 'a', issues: [makeVulnIssue(), makeVulnIssue()] }),
        makeRelease({ packageName: 'b', issues: [makeMalwareIssue()] }),
      ],
      7,
      [],
    );
    const summary = lineWith(out, 'Scan Summary');
    expect(summary).toContain('7 dependencies checked');
    expect(summary).toContain('3 risks found');
  });

  it('renders a package header, file paths, chain, and issue row', () => {
    const out = fmt(
      [
        makeRelease({
          packageName: 'foo',
          version: '1.0.0',
          dependencyFilePaths: ['package-lock.json'],
          dependencyChains: [['pkg:npm/lodash@4.17.21', 'pkg:npm/foo@1.0.0']],
          issues: [makeVulnIssue({ severity: 'HIGH', vulnerabilityId: 'CVE-1' })],
        }),
      ],
      1,
      [],
    );

    const header = lineWith(out, 'foo@1.0.0');
    expect(header).toContain('foo@1.0.0');
    expect(header).toContain('(1 risk)');

    expect(lineWith(out, 'package-lock.json')).toContain('in:');

    const viaLine = lineWith(out, 'lodash@4.17.21');
    expect(viaLine).toContain('via');
    expect(viaLine).toContain('lodash@4.17.21');
    expect(viaLine).toContain('foo@1.0.0');

    const row = lineWith(out, 'CVE-1');
    expect(row).toContain('HIGH');
    expect(row).toContain('OPEN');
    expect(row).toContain('CVE-1');
  });

  it('marks newly introduced packages with [NEW] in the header', () => {
    const out = fmt([makeRelease({ newlyIntroduced: true, issues: [makeVulnIssue()] })], 1, []);
    const header = lineWith(out, 'foo@1.0.0');
    expect(header).toContain('foo@1.0.0');
    expect(header).toContain('[NEW]');
  });

  it('joins multiple file paths into one in: line', () => {
    const out = fmt(
      [
        makeRelease({
          dependencyFilePaths: ['package-lock.json', 'sub/package-lock.json'],
          issues: [makeVulnIssue()],
        }),
      ],
      1,
      [],
    );
    const inLine = lineWith(out, 'in:');
    expect(inLine).toContain('package-lock.json');
    expect(inLine).toContain('sub/package-lock.json');
  });

  it('omits the in: line when there are no file paths', () => {
    const out = fmt([makeRelease({ dependencyFilePaths: [], issues: [makeVulnIssue()] })], 1, []);
    expect(out.split('\n').some((l) => l.startsWith('in:'))).toBe(false);
  });

  it('renders a single-entry chain as a via line with just that package', () => {
    const out = fmt(
      [
        makeRelease({
          dependencyChains: [['pkg:npm/foo@1.0.0']],
          issues: [makeVulnIssue()],
        }),
      ],
      1,
      [],
    );
    const viaLines = out.split('\n').filter((l) => l.trimStart().startsWith('via'));
    expect(viaLines).toHaveLength(1);
    expect(viaLines[0]).toBe('via foo@1.0.0');
  });

  it('renders multiple issues for the same release on consecutive lines', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [
            makeVulnIssue({ severity: 'BLOCKER', vulnerabilityId: 'CVE-A' }),
            makeVulnIssue({ severity: 'MEDIUM', vulnerabilityId: 'CVE-B' }),
          ],
        }),
      ],
      1,
      [],
    );
    const rowA = lineWith(out, 'CVE-A');
    expect(rowA).toContain('BLOCKER');
    expect(rowA).toContain('OPEN');

    const rowB = lineWith(out, 'CVE-B');
    expect(rowB).toContain('MEDIUM');
    expect(rowB).toContain('OPEN');
  });

  it('uses singular "risk" in the header for one issue', () => {
    const out = fmt([makeRelease({ issues: [makeVulnIssue()] })], 1, []);
    const header = lineWith(out, 'foo@1.0.0');
    expect(header).toContain('(1 risk)');
    expect(header).not.toContain('(1 risks)');
  });

  it('uses plural "risks" in the header for more than one issue', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [
            makeVulnIssue({ vulnerabilityId: 'CVE-A' }),
            makeVulnIssue({ vulnerabilityId: 'CVE-B' }),
          ],
        }),
      ],
      1,
      [],
    );
    const header = lineWith(out, 'foo@1.0.0');
    expect(header).toContain('(2 risks)');
  });

  it('renders MALWARE issues with the malware label and removal remediation', () => {
    const out = fmt([makeRelease({ issues: [makeMalwareIssue()] })], 1, []);
    const row = lineWith(out, 'Malicious package');
    expect(row).toContain('BLOCKER');
    expect(row).toContain('OPEN');
    expect(row).toContain('Malicious package');
    expect(out).toContain('Remove dependency');
  });

  it('renders PROHIBITED_LICENSE issues with the spdxLicenseId and review remediation', () => {
    const out = fmt(
      [makeRelease({ issues: [makeLicenseIssue({ spdxLicenseId: 'AGPL-3.0' })] })],
      1,
      [],
    );
    const row = lineWith(out, 'AGPL-3.0');
    expect(row).toContain('HIGH');
    expect(row).toContain('OPEN');
    expect(row).toContain('AGPL-3.0');
    expect(out).toContain('Review usage');
  });

  it('falls back to release.licenseExpression when the issue has no spdxLicenseId', () => {
    const out = fmt(
      [
        makeRelease({
          licenseExpression: 'AGPL-3.0',
          issues: [makeLicenseIssue({ spdxLicenseId: null })],
        }),
      ],
      1,
      [],
    );
    const row = lineWith(out, 'AGPL-3.0');
    expect(row).toContain('HIGH');
    expect(row).toContain('AGPL-3.0');
    expect(out).toContain('Review usage');
  });

  it('uppercases lowercase severities at render time', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [makeVulnIssue({ severity: 'high', vulnerabilityId: 'CVE-LOWER' })],
        }),
      ],
      1,
      [],
    );
    const row = lineWith(out, 'CVE-LOWER');
    expect(row).toContain('HIGH');
    expect(row).not.toContain('high');
  });

  it('defaults missing status to OPEN at render time', () => {
    const out = fmt([makeRelease({ issues: [makeVulnIssue({ status: null })] })], 1, []);
    const row = lineWith(out, 'CVE-1');
    expect(row).toContain('OPEN');
  });

  it('renders status as NEW when status is null on a newly introduced release', () => {
    const out = fmt(
      [makeRelease({ newlyIntroduced: true, issues: [makeVulnIssue({ status: null })] })],
      1,
      [],
    );
    const row = lineWith(out, 'CVE-1');
    expect(row).toContain('NEW');
  });

  it('renders an upgrade remediation that picks the highest-priority option', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-1',
              versionOptions: [
                {
                  version: '4.17.21',
                  vulnerabilityIds: ['CVE-1', 'CVE-2'],
                  prerelease: false,
                  fixLevel: 'NONE',
                  descriptionCode: 'VERSION_IN_USE',
                },
                {
                  version: '5.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'NEAREST_COMPLETE',
                },
              ],
            }),
          ],
        }),
      ],
      1,
      [],
    );
    const row = lineWith(out, 'CVE-1');
    expect(row).toContain('CVE-1');
    expect(out).toContain('Change version to');
    expect(out).toContain('5.0.0 (complete fix)');
  });

  it('appends an Errors section with both path-qualified and path-less entries', () => {
    const errors: AnalysisErrorResource[] = [
      { id: 'e1', code: 'MISSING_LOCKFILE', path: 'app/', message: 'No lockfile found' },
      { id: 'e2', code: 'UNKNOWN', path: null, message: 'Something went wrong' },
    ];
    const out = fmt([makeRelease({ issues: [makeVulnIssue()] })], 1, errors);
    expect(out).toContain('Errors:');

    const withPath = lineWith(out, 'MISSING_LOCKFILE');
    expect(withPath).toContain('[MISSING_LOCKFILE]');
    expect(withPath).toContain('app/');
    expect(withPath).toContain('No lockfile found');

    const withoutPath = lineWith(out, 'Something went wrong');
    expect(withoutPath).toContain('[UNKNOWN]');
    expect(withoutPath).toContain('Something went wrong');
    expect(withoutPath).not.toContain(': Something went wrong');
  });

  it('appends Errors even when there are no risks', () => {
    const errors: AnalysisErrorResource[] = [
      { id: 'e1', code: 'NO_DEPENDENCIES_FOUND', path: null, message: 'no deps' },
    ];
    const out = fmt([], 0, errors);
    const summary = lineWith(out, 'Scan Summary');
    expect(summary).toContain('0 dependencies checked');
    expect(summary).toContain('0 risks found');
    expect(out).toContain('Errors:');
    const errLine = lineWith(out, 'NO_DEPENDENCIES_FOUND');
    expect(errLine).toContain('[NO_DEPENDENCIES_FOUND]');
    expect(errLine).toContain('no deps');
  });

  it('renders a header even when the package name overflows the separator width', () => {
    const longName = 'a'.repeat(60);
    const out = fmt(
      [
        makeRelease({
          packageName: longName,
          version: '1.0.0',
          issues: [makeVulnIssue()],
        }),
      ],
      1,
      [],
    );
    const header = lineWith(out, longName);
    expect(header).toContain(`${longName}@1.0.0`);
    expect(header).toContain('(1 risk)');
  });

  it('omits the remediation when a VULNERABILITY has no versionOptions', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [makeVulnIssue({ vulnerabilityId: 'CVE-NO-FIX', versionOptions: null })],
        }),
      ],
      1,
      [],
    );
    expect(out).toContain('CVE-NO-FIX');
    expect(out).not.toContain('Change version to');
  });

  it('omits the remediation when versionOptions is an empty array', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [makeVulnIssue({ vulnerabilityId: 'CVE-EMPTY', versionOptions: [] })],
        }),
      ],
      1,
      [],
    );
    expect(out).toContain('CVE-EMPTY');
    expect(out).not.toContain('Change version to');
  });

  it('omits the remediation when every version option has fixLevel NONE', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-ONLY-NONE',
              versionOptions: [
                {
                  version: '1.0.0',
                  vulnerabilityIds: ['CVE-ONLY-NONE'],
                  prerelease: false,
                  fixLevel: 'NONE',
                  descriptionCode: 'VERSION_IN_USE',
                },
                {
                  version: '1.1.0',
                  vulnerabilityIds: ['CVE-ONLY-NONE'],
                  prerelease: false,
                  fixLevel: 'NONE',
                  descriptionCode: 'LATEST_STABLE',
                },
              ],
            }),
          ],
        }),
      ],
      1,
      [],
    );
    expect(out).toContain('CVE-ONLY-NONE');
    expect(out).not.toContain('Change version to');
    expect(out).not.toContain('(complete fix)');
    expect(out).not.toContain('(partial fix)');
  });

  it('orders upgrade options by descriptionCode priority and filters out VERSION_IN_USE and UNKNOWN', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-SORT',
              versionOptions: [
                {
                  version: '9.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'NONE',
                  descriptionCode: 'VERSION_IN_USE',
                },
                {
                  version: '8.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'UNKNOWN',
                },
                {
                  version: '7.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'PARTIAL',
                  descriptionCode: 'NEAREST_PARTIAL',
                },
                {
                  version: '5.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'LATEST_COMPLETE',
                },
                {
                  version: '4.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'NEAREST_COMPLETE',
                },
              ],
            }),
          ],
        }),
      ],
      1,
      [],
    );
    expect(out).toContain('CVE-SORT');
    expect(out).toContain('5.0.0 (complete fix)');
    expect(out).toContain('4.0.0 (complete fix)');
    expect(out).toContain('7.0.0 (partial fix)');
    const latestComplete = out.indexOf('5.0.0');
    const nearestComplete = out.indexOf('4.0.0');
    const nearestPartial = out.indexOf('7.0.0');
    expect(nearestComplete).toBeGreaterThan(latestComplete);
    expect(nearestPartial).toBeGreaterThan(nearestComplete);
    expect(out).not.toContain('9.0.0');
    expect(out).not.toContain('8.0.0');
  });

  it('caps the upgrade remediation at three options', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-CAP',
              versionOptions: [
                {
                  version: '1.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'NEAREST_COMPLETE',
                },
                {
                  version: '2.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'NEAREST_PARTIAL',
                },
                {
                  version: '3.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'LATEST_COMPLETE',
                },
                {
                  version: '4.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'LATEST_PARTIAL',
                },
                {
                  version: '5.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'LATEST_STABLE',
                },
              ],
            }),
          ],
        }),
      ],
      1,
      [],
    );
    expect(out).toContain('CVE-CAP');
    expect(out).toContain('5.0.0 (complete fix)');
    expect(out).toContain('3.0.0 (complete fix)');
    expect(out).toContain('4.0.0 (complete fix)');
    expect(out).not.toContain('1.0.0 (complete fix)');
    expect(out).not.toContain('2.0.0 (complete fix)');
    const latestStable = out.indexOf('5.0.0');
    const latestComplete = out.indexOf('3.0.0');
    const latestPartial = out.indexOf('4.0.0');
    expect(latestComplete).toBeGreaterThan(latestStable);
    expect(latestPartial).toBeGreaterThan(latestComplete);
  });

  it('renders a via line for every chain when all chains have at least two entries', () => {
    const out = fmt(
      [
        makeRelease({
          dependencyChains: [
            ['pkg:npm/a@1', 'pkg:npm/foo@1.0.0'],
            ['pkg:npm/b@2', 'pkg:npm/c@3', 'pkg:npm/foo@1.0.0'],
          ],
          issues: [makeVulnIssue()],
        }),
      ],
      1,
      [],
    );
    const viaLines = out.split('\n').filter((l) => l.trimStart().startsWith('via'));
    expect(viaLines).toHaveLength(2);
    expect(viaLines[0]).toContain('a@1');
    expect(viaLines[0]).toContain('foo@1.0.0');
    expect(viaLines[1]).toContain('b@2');
    expect(viaLines[1]).toContain('c@3');
    expect(viaLines[1]).toContain('foo@1.0.0');
  });

  it('renders chains of any length, ordered shortest-first', () => {
    const out = fmt(
      [
        makeRelease({
          dependencyChains: [
            ['pkg:npm/a@1', 'pkg:npm/b@2', 'pkg:npm/foo@1.0.0'],
            ['pkg:npm/foo@1.0.0'],
          ],
          issues: [makeVulnIssue()],
        }),
      ],
      1,
      [],
    );
    const viaLines = out.split('\n').filter((l) => l.trimStart().startsWith('via'));
    expect(viaLines).toHaveLength(2);
    expect(viaLines[0]).toBe('via foo@1.0.0');
    expect(viaLines[1]).toContain('a@1');
    expect(viaLines[1]).toContain('b@2');
    expect(viaLines[1]).toContain('foo@1.0.0');
  });

  it('replaces chain purls with name@version looked up from the releases list', () => {
    const out = fmt(
      [
        makeRelease({
          packageName: 'foo',
          version: '1.0.0',
          packageUrl: 'pkg:npm/foo@1.0.0',
          dependencyChains: [['pkg:npm/lodash@4.17.21', 'pkg:npm/foo@1.0.0']],
          issues: [makeVulnIssue()],
        }),
        makeRelease({
          packageName: 'lodash',
          version: '4.17.21',
          packageUrl: 'pkg:npm/lodash@4.17.21',
          issues: [],
        }),
      ],
      2,
      [],
    );
    const viaLine = lineWith(out, '→');
    expect(viaLine).toBe('via lodash@4.17.21 → foo@1.0.0');
  });

  it('falls back to the raw purl when no release matches a chain entry', () => {
    const out = fmt(
      [
        makeRelease({
          packageName: 'foo',
          version: '1.0.0',
          packageUrl: 'pkg:npm/foo@1.0.0',
          dependencyChains: [['pkg:maven/com.foo/bar@1', 'pkg:npm/foo@1.0.0']],
          issues: [makeVulnIssue()],
        }),
      ],
      1,
      [],
    );
    const viaLine = lineWith(out, '→');
    expect(viaLine).toBe('via pkg:maven/com.foo/bar@1 → foo@1.0.0');
  });

  it('keeps only the three shortest chains and appends "and via N others" for the rest', () => {
    const out = fmt(
      [
        makeRelease({
          packageName: 'foo',
          version: '1.0.0',
          packageUrl: 'pkg:npm/foo@1.0.0',
          dependencyChains: [
            ['pkg:npm/a1@1', 'pkg:npm/a2@1', 'pkg:npm/a3@1', 'pkg:npm/foo@1.0.0'],
            ['pkg:npm/b1@1', 'pkg:npm/foo@1.0.0'],
            ['pkg:npm/c1@1', 'pkg:npm/c2@1', 'pkg:npm/foo@1.0.0'],
            ['pkg:npm/d1@1', 'pkg:npm/d2@1', 'pkg:npm/d3@1', 'pkg:npm/d4@1', 'pkg:npm/foo@1.0.0'],
            ['pkg:npm/e1@1', 'pkg:npm/e2@1', 'pkg:npm/foo@1.0.0'],
          ],
          issues: [makeVulnIssue()],
        }),
      ],
      1,
      [],
    );
    const viaLines = out.split('\n').filter((l) => l.trimStart().startsWith('via'));
    expect(viaLines).toHaveLength(3);
    expect(viaLines[0]).toContain('b1@1');
    expect(viaLines[1]).toContain('c1@1');
    expect(viaLines[1]).toContain('c2@1');
    expect(viaLines[2]).toContain('e1@1');
    expect(viaLines[2]).toContain('e2@1');
    expect(out).toContain('and via 2 others');
    expect(out).not.toContain('a1@1');
    expect(out).not.toContain('a2@1');
    expect(out).not.toContain('a3@1');
    expect(out).not.toContain('d1@1');
    expect(out).not.toContain('d4@1');
  });

  it('omits the "and via N others" tail when there are at most three chains', () => {
    const out = fmt(
      [
        makeRelease({
          dependencyChains: [
            ['pkg:npm/a@1', 'pkg:npm/foo@1.0.0'],
            ['pkg:npm/b@1', 'pkg:npm/foo@1.0.0'],
            ['pkg:npm/c@1', 'pkg:npm/foo@1.0.0'],
          ],
          issues: [makeVulnIssue()],
        }),
      ],
      1,
      [],
    );
    expect(out).not.toContain('and via');
  });

  it('renders a separate header and issue rows for each release with issues', () => {
    const out = fmt(
      [
        makeRelease({
          packageName: 'alpha',
          version: '1.0.0',
          issues: [makeVulnIssue({ vulnerabilityId: 'CVE-ALPHA' })],
        }),
        makeRelease({
          packageName: 'beta',
          version: '2.0.0',
          issues: [makeVulnIssue({ vulnerabilityId: 'CVE-BETA' })],
        }),
      ],
      2,
      [],
    );
    expect(lineWith(out, 'alpha@1.0.0')).toContain('alpha@1.0.0');
    expect(lineWith(out, 'beta@2.0.0')).toContain('beta@2.0.0');
    expect(out).toContain('CVE-ALPHA');
    expect(out).toContain('CVE-BETA');
  });

  it('skips releases that have no issues', () => {
    const out = fmt(
      [
        makeRelease({ packageName: 'empty', version: '0.0.1', issues: [] }),
        makeRelease({
          packageName: 'busy',
          version: '1.0.0',
          issues: [makeVulnIssue({ vulnerabilityId: 'CVE-BUSY' })],
        }),
      ],
      2,
      [],
    );
    expect(out).not.toContain('empty@0.0.1');
    expect(out).toContain('busy@1.0.0');
    expect(out).toContain('CVE-BUSY');
  });

  it('resolves dependency-chain labels using the full releases list even when the chain transits through a release not in the filtered set', () => {
    const transit = makeRelease({
      key: 'release-transit',
      packageName: 'transit',
      version: '1.0.0',
      packageUrl: 'pkg:npm/transit@1.0.0',
      issues: [],
    });
    const foo = makeRelease({
      packageName: 'foo',
      packageUrl: 'pkg:npm/foo@1.0.0',
      dependencyChains: [['pkg:npm/transit@1.0.0', 'pkg:npm/foo@1.0.0']],
      issues: [makeVulnIssue({ status: 'OPEN', vulnerabilityId: 'CVE-1' })],
    });

    const out = formatDependencyRisksTable({ releases: [foo], parsedFiles: [], errors: [] }, [
      transit,
      foo,
    ]);

    expect(out).toContain('via transit@1.0.0 → foo@1.0.0');
  });

  it('renders the remediation on its own indented line(s) under the CVE id', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-LAYOUT',
              versionOptions: [
                {
                  version: '2.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'LATEST_STABLE',
                },
              ],
            }),
          ],
        }),
      ],
      1,
      [],
    );
    const lines = out.split('\n');
    const cveIndex = lines.findIndex((l) => l.includes('CVE-LAYOUT'));
    expect(cveIndex).toBeGreaterThan(-1);
    expect(lines[cveIndex]).not.toContain('Change version to');
    expect(lines[cveIndex]).not.toContain('→');
    expect(lines[cveIndex + 1]).toBe('                   Change version to 2.0.0 (complete fix)');
  });

  it('caps issues at three per release and appends "... and N more risks"', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [
            makeVulnIssue({ severity: 'BLOCKER', vulnerabilityId: 'CVE-1' }),
            makeVulnIssue({ severity: 'HIGH', vulnerabilityId: 'CVE-2' }),
            makeVulnIssue({ severity: 'MEDIUM', vulnerabilityId: 'CVE-3' }),
            makeVulnIssue({ severity: 'LOW', vulnerabilityId: 'CVE-4' }),
            makeVulnIssue({ severity: 'INFO', vulnerabilityId: 'CVE-5' }),
          ],
        }),
      ],
      1,
      [],
    );
    expect(out).toContain('CVE-1');
    expect(out).toContain('CVE-2');
    expect(out).toContain('CVE-3');
    expect(out).not.toContain('CVE-4');
    expect(out).not.toContain('CVE-5');
    expect(out).toContain('                   ... and 2 more risks (1 LOW, 1 INFO)');
    const header = lineWith(out, 'foo@1.0.0');
    expect(header).toContain('(5 risks)');
  });

  it('keeps only the top three issues by severity after sortReleases', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [
            makeVulnIssue({ severity: 'LOW', vulnerabilityId: 'CVE-LOW' }),
            makeVulnIssue({ severity: 'INFO', vulnerabilityId: 'CVE-INFO' }),
            makeVulnIssue({ severity: 'BLOCKER', vulnerabilityId: 'CVE-BLK' }),
            makeVulnIssue({ severity: 'HIGH', vulnerabilityId: 'CVE-HIGH' }),
            makeVulnIssue({ severity: 'MEDIUM', vulnerabilityId: 'CVE-MED' }),
          ],
        }),
      ],
      1,
      [],
    );
    expect(out).toContain('CVE-BLK');
    expect(out).toContain('CVE-HIGH');
    expect(out).toContain('CVE-MED');
    expect(out).not.toContain('CVE-LOW');
    expect(out).not.toContain('CVE-INFO');
    expect(out).toContain('... and 2 more risks (1 LOW, 1 INFO)');
  });

  it('breaks down hidden-risk counts by severity, skipping severities with zero hidden', () => {
    const issues = [
      // 3 BLOCKER take the visible slots
      makeVulnIssue({ severity: 'BLOCKER', vulnerabilityId: 'CVE-V1' }),
      makeVulnIssue({ severity: 'BLOCKER', vulnerabilityId: 'CVE-V2' }),
      makeVulnIssue({ severity: 'BLOCKER', vulnerabilityId: 'CVE-V3' }),
      // hidden: 2 HIGH, 0 MEDIUM, 3 LOW, 0 INFO
      makeVulnIssue({ severity: 'HIGH', vulnerabilityId: 'CVE-H1' }),
      makeVulnIssue({ severity: 'HIGH', vulnerabilityId: 'CVE-H2' }),
      makeVulnIssue({ severity: 'LOW', vulnerabilityId: 'CVE-L1' }),
      makeVulnIssue({ severity: 'LOW', vulnerabilityId: 'CVE-L2' }),
      makeVulnIssue({ severity: 'LOW', vulnerabilityId: 'CVE-L3' }),
    ];
    const out = fmt([makeRelease({ issues })], 1, []);
    expect(out).toContain('... and 5 more risks (2 HIGH, 3 LOW)');
    expect(out).not.toContain('MEDIUM');
    expect(out).not.toContain('INFO');
  });

  it('omits the "... and N more risks" tail when there are at most three issues', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [
            makeVulnIssue({ vulnerabilityId: 'CVE-A' }),
            makeVulnIssue({ vulnerabilityId: 'CVE-B' }),
            makeVulnIssue({ vulnerabilityId: 'CVE-C' }),
          ],
        }),
      ],
      1,
      [],
    );
    expect(out).not.toContain('more risks');
  });

  it('wraps a remediation that exceeds 80 chars on the " | " boundary', () => {
    const out = fmt(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-WRAP',
              versionOptions: [
                {
                  version: '5.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'LATEST_STABLE',
                },
                {
                  version: '4.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'NEAREST_COMPLETE',
                },
                {
                  version: '3.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'PARTIAL',
                  descriptionCode: 'NEAREST_PARTIAL',
                },
              ],
            }),
          ],
        }),
      ],
      1,
      [],
    );
    const lines = out.split('\n');
    const cveIndex = lines.findIndex((l) => l.includes('CVE-WRAP'));
    // Greedy pack: line 1 fits the first two fragments (80 chars total),
    // line 2 carries the spillover starting with the "| " separator.
    expect(lines[cveIndex + 1]).toBe(
      '                   Change version to 5.0.0 (complete fix) | 4.0.0 (complete fix)',
    );
    expect(lines[cveIndex + 2]).toBe('                   | 3.0.0 (partial fix)');
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('renders a short chain on a single via line without wrapping', () => {
    const out = fmt(
      [
        makeRelease({
          packageName: 'foo',
          version: '1.0.0',
          packageUrl: 'pkg:npm/foo@1.0.0',
          dependencyChains: [['pkg:npm/a@1', 'pkg:npm/b@2', 'pkg:npm/foo@1.0.0']],
          issues: [makeVulnIssue()],
        }),
      ],
      1,
      [],
    );
    const lines = out.split('\n');
    const viaLine = lines.find((l) => l.startsWith('via '));
    expect(viaLine).toBe('via pkg:npm/a@1 → pkg:npm/b@2 → foo@1.0.0');
    expect(lines.some((l) => l.startsWith('    → '))).toBe(false);
  });

  it('wraps a chain that exceeds 80 chars with "    → " continuation', () => {
    const long = '@scope-with-a-really-long-name/sub-package';
    const a = `${long}-aaaa`;
    const b = `${long}-bbbb`;
    const out = fmt(
      [
        makeRelease({
          packageName: 'foo',
          version: '1.0.0',
          packageUrl: 'pkg:npm/foo@1.0.0',
          dependencyChains: [[`pkg:npm/${a}@1.0.0`, `pkg:npm/${b}@2.0.0`, 'pkg:npm/foo@1.0.0']],
          issues: [makeVulnIssue()],
        }),
      ],
      1,
      [],
    );
    const lines = out.split('\n');
    const viaLine = lines.find((l) => l.startsWith('via '));
    expect(viaLine).toBeDefined();
    expect(viaLine!.length).toBeLessThanOrEqual(80);
    const continuation = lines.find((l) => l.startsWith('    → '));
    expect(continuation).toBeDefined();
    expect(continuation!.length).toBeLessThanOrEqual(80);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    expect(out).toContain(a);
    expect(out).toContain(b);
    expect(out).toContain('foo@1.0.0');
  });
});
