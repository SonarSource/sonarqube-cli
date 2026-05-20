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
import { buildRiskFilter } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/risk-filter.ts';
import type {
  AnalysisErrorResource,
  AnalyzeProjectIssue,
  AnalyzeProjectRelease,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import { formatDependencyRisksTable } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/table/format-dependency-risks-table.ts';

function renderTable(response: {
  releases: AnalyzeProjectRelease[];
  parsedFiles: string[];
  errors: AnalysisErrorResource[];
}): string {
  return formatDependencyRisksTable(
    buildDependencyRisksViewModel(response, buildRiskFilter('all')),
  );
}

function makeRelease(overrides: Partial<AnalyzeProjectRelease> = {}): AnalyzeProjectRelease {
  const packageName = overrides.packageName ?? 'foo';
  const version = overrides.version ?? '1.0.0';
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

function getLineWithText(out: string, marker: string): string {
  const line = out.split('\n').find((l) => l.includes(marker));
  if (!line) {
    throw new Error(`No line containing "${marker}" in:\n${out}`);
  }
  return line;
}

function getFormattedTableWithReleases(
  releases: AnalyzeProjectRelease[],
  packagesScanned?: number,
  errors: AnalysisErrorResource[] = [],
): string {
  const withChainTargets = withChainTargetReleases(releases);
  const total = packagesScanned ?? withChainTargets.length;
  const padding = Math.max(0, total - withChainTargets.length);
  const allReleases: AnalyzeProjectRelease[] = [
    ...withChainTargets,
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
  return renderTable({ releases: allReleases, parsedFiles: [], errors });
}

/**
 * Adds zero-issue stub releases for every purl referenced in any chain that isn't
 * already covered by `releases`. Keeps test fixtures concise — fixtures only have
 * to declare the packages whose data they actually care about.
 */
function withChainTargetReleases(releases: AnalyzeProjectRelease[]): AnalyzeProjectRelease[] {
  const knownPurls = new Set(releases.map((r) => r.packageUrl));
  const stubs: AnalyzeProjectRelease[] = [];
  for (const release of releases) {
    for (const chain of release.dependencyChains) {
      for (const purl of chain) {
        if (knownPurls.has(purl)) continue;
        knownPurls.add(purl);
        stubs.push(stubReleaseForPurl(purl));
      }
    }
  }
  return [...releases, ...stubs];
}

function stubReleaseForPurl(purl: string): AnalyzeProjectRelease {
  const { packageManager, name, version } = parsePurl(purl);
  return makeRelease({
    key: `stub-${purl}`,
    packageUrl: purl,
    packageManager,
    packageName: name,
    version,
    issues: [],
    dependencyChains: [],
  });
}

function parsePurl(purl: string): { packageManager: string; name: string; version: string } {
  const atIdx = purl.lastIndexOf('@');
  const version = atIdx > 0 ? purl.slice(atIdx + 1) : '';
  const rest = atIdx > 0 ? purl.slice(0, atIdx) : purl;
  const match = /^pkg:([^/]+)\/(.+)$/.exec(rest);
  return match
    ? { packageManager: match[1], name: match[2], version }
    : { packageManager: '', name: purl, version: '' };
}

describe('formatDependencyRisksTable', () => {
  it('emits a clean-scan message when there are no risks and no errors', () => {
    const out = getFormattedTableWithReleases([], 0, []);
    expect(out).toContain('Summary: 0 dependencies checked, 0 risks found');
    expect(out).toContain('No dependency risks found.');
  });

  it('still shows the clean-scan message and the Errors section when there are no risks but errors are present', () => {
    const out = getFormattedTableWithReleases([], 0, [
      { id: 'e1', code: 'NO_DEPENDENCIES_FOUND', path: null, message: 'no deps' },
    ]);
    expect(out).toContain('No dependency risks found.');
    expect(out).toContain('Errors:');
    expect(out).toContain('[NO_DEPENDENCIES_FOUND]');
  });

  it('counts total risks across all releases in the summary line', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({ packageName: 'a', issues: [makeVulnIssue(), makeVulnIssue()] }),
        makeRelease({ packageName: 'b', issues: [makeMalwareIssue()] }),
      ],
      7,
      [],
    );
    const summary = getLineWithText(out, 'Summary:');
    expect(summary).toContain('7 dependencies checked');
    expect(summary).toContain('3 risks found');
  });

  it('renders a package header, file paths, chain, and issue row', () => {
    const out = getFormattedTableWithReleases(
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

    const header = getLineWithText(out, 'foo@1.0.0');
    expect(header).toContain('foo@1.0.0');
    expect(header).toContain('(1 risk)');

    expect(getLineWithText(out, 'package-lock.json')).toContain('in:');

    const viaLine = getLineWithText(out, 'lodash@4.17.21');
    expect(viaLine).toContain('via');
    expect(viaLine).toContain('lodash@4.17.21');
    expect(viaLine).toContain('foo@1.0.0');

    const row = getLineWithText(out, 'CVE-1');
    expect(row).toContain('HIGH');
    expect(row).toContain('OPEN');
    expect(row).toContain('CVE-1');
  });

  it('marks newly introduced packages with [NEW] in the header', () => {
    const out = getFormattedTableWithReleases(
      [makeRelease({ newlyIntroduced: true, issues: [makeVulnIssue()] })],
      1,
      [],
    );
    const header = getLineWithText(out, 'foo@1.0.0');
    expect(header).toContain('foo@1.0.0');
    expect(header).toContain('[NEW]');
  });

  it('joins multiple file paths into one in: line', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          dependencyFilePaths: ['package-lock.json', 'sub/package-lock.json'],
          issues: [makeVulnIssue()],
        }),
      ],
      1,
      [],
    );
    const inLine = getLineWithText(out, 'in:');
    expect(inLine).toContain('package-lock.json');
    expect(inLine).toContain('sub/package-lock.json');
  });

  it('omits the in: line when there are no file paths', () => {
    const out = getFormattedTableWithReleases(
      [makeRelease({ dependencyFilePaths: [], issues: [makeVulnIssue()] })],
      1,
      [],
    );
    expect(out.split('\n').some((l) => l.startsWith('in:'))).toBe(false);
  });

  it('renders a single-entry chain as a via line with just that package', () => {
    const out = getFormattedTableWithReleases(
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
    expect(viaLines[0].trimStart()).toBe('via foo@1.0.0');
  });

  it('renders multiple issues for the same release on consecutive lines', () => {
    const out = getFormattedTableWithReleases(
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
    const rowA = getLineWithText(out, 'CVE-A');
    expect(rowA).toContain('BLOCKER');
    expect(rowA).toContain('OPEN');

    const rowB = getLineWithText(out, 'CVE-B');
    expect(rowB).toContain('MEDIUM');
    expect(rowB).toContain('OPEN');
  });

  it('uses singular "risk" in the header for one issue', () => {
    const out = getFormattedTableWithReleases([makeRelease({ issues: [makeVulnIssue()] })], 1, []);
    const header = getLineWithText(out, 'foo@1.0.0');
    expect(header).toContain('(1 risk)');
    expect(header).not.toContain('(1 risks)');
  });

  it('uses plural "risks" in the header for more than one issue', () => {
    const out = getFormattedTableWithReleases(
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
    const header = getLineWithText(out, 'foo@1.0.0');
    expect(header).toContain('(2 risks)');
  });

  it('renders MALWARE issues with the malware label and removal remediation', () => {
    const out = getFormattedTableWithReleases(
      [makeRelease({ issues: [makeMalwareIssue()] })],
      1,
      [],
    );
    const row = getLineWithText(out, 'Malicious package');
    expect(row).toContain('BLOCKER');
    expect(row).toContain('OPEN');
    expect(row).toContain('Malicious package');
    expect(out).toContain('Remove this package and notify your information security team');
  });

  it('renders PROHIBITED_LICENSE issues with the spdxLicenseId and review remediation', () => {
    const out = getFormattedTableWithReleases(
      [makeRelease({ issues: [makeLicenseIssue({ spdxLicenseId: 'AGPL-3.0' })] })],
      1,
      [],
    );
    const row = getLineWithText(out, 'AGPL-3.0');
    expect(row).toContain('HIGH');
    expect(row).toContain('OPEN');
    expect(row).toContain('AGPL-3.0');
    expect(out).toContain('Review the license usage');
  });

  it('falls back to release.licenseExpression when the issue has no spdxLicenseId', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          licenseExpression: 'AGPL-3.0',
          issues: [makeLicenseIssue({ spdxLicenseId: null })],
        }),
      ],
      1,
      [],
    );
    const row = getLineWithText(out, 'AGPL-3.0');
    expect(row).toContain('HIGH');
    expect(row).toContain('AGPL-3.0');
    expect(out).toContain('Review the license usage');
  });

  it('defaults missing status to OPEN at render time', () => {
    const out = getFormattedTableWithReleases(
      [makeRelease({ issues: [makeVulnIssue({ status: null })] })],
      1,
      [],
    );
    const row = getLineWithText(out, 'CVE-1');
    expect(row).toContain('OPEN');
  });

  it('renders status as NEW when status is null on a newly introduced release', () => {
    const out = getFormattedTableWithReleases(
      [makeRelease({ newlyIntroduced: true, issues: [makeVulnIssue({ status: null })] })],
      1,
      [],
    );
    const row = getLineWithText(out, 'CVE-1');
    expect(row).toContain('NEW');
  });

  it('hoists the highest-priority complete fix into the package-level Fix line', () => {
    const out = getFormattedTableWithReleases(
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
    const fixLine = getLineWithText(out, 'Recommended versions without known vulnerabilities:');
    expect(fixLine).toContain('5.0.0 (nearest)');
  });

  it('appends an Errors section with both path-qualified and path-less entries', () => {
    const errors: AnalysisErrorResource[] = [
      { id: 'e1', code: 'MISSING_LOCKFILE', path: 'app/', message: 'No lockfile found' },
      { id: 'e2', code: 'UNKNOWN', path: null, message: 'Something went wrong' },
    ];
    const out = getFormattedTableWithReleases(
      [makeRelease({ issues: [makeVulnIssue()] })],
      1,
      errors,
    );
    expect(out).toContain('Errors:');

    const withPath = getLineWithText(out, 'MISSING_LOCKFILE');
    expect(withPath).toContain('[MISSING_LOCKFILE]');
    expect(withPath).toContain('app/');
    expect(withPath).toContain('No lockfile found');

    const withoutPath = getLineWithText(out, 'Something went wrong');
    expect(withoutPath).toContain('[UNKNOWN]');
    expect(withoutPath).toContain('Something went wrong');
    expect(withoutPath).not.toContain(': Something went wrong');
  });

  it('appends Errors even when there are no risks', () => {
    const errors: AnalysisErrorResource[] = [
      { id: 'e1', code: 'NO_DEPENDENCIES_FOUND', path: null, message: 'no deps' },
    ];
    const out = getFormattedTableWithReleases([], 0, errors);
    const summary = getLineWithText(out, 'Summary:');
    expect(summary).toContain('0 dependencies checked');
    expect(summary).toContain('0 risks found');
    expect(out).toContain('Errors:');
    const errLine = getLineWithText(out, 'NO_DEPENDENCIES_FOUND');
    expect(errLine).toContain('[NO_DEPENDENCIES_FOUND]');
    expect(errLine).toContain('no deps');
  });

  it('renders a header even when the package name overflows the separator width', () => {
    const longName = 'a'.repeat(60);
    const out = getFormattedTableWithReleases(
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
    const header = getLineWithText(out, longName);
    expect(header).toContain(`${longName}@1.0.0`);
    expect(header).toContain('(1 risk)');
  });

  it('renders "→ no known fix" when a VULNERABILITY has no versionOptions', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [makeVulnIssue({ vulnerabilityId: 'CVE-NO-FIX', versionOptions: null })],
        }),
      ],
      1,
      [],
    );
    const row = getLineWithText(out, 'CVE-NO-FIX');
    expect(row).toContain('→ no known fix');
  });

  it('renders "→ no known fix" when versionOptions is an empty array', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [makeVulnIssue({ vulnerabilityId: 'CVE-EMPTY', versionOptions: [] })],
        }),
      ],
      1,
      [],
    );
    const row = getLineWithText(out, 'CVE-EMPTY');
    expect(row).toContain('→ no known fix');
  });

  it('renders "→ no known fix" when every version option has fixLevel NONE', () => {
    const out = getFormattedTableWithReleases(
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
    const row = getLineWithText(out, 'CVE-ONLY-NONE');
    expect(row).toContain('→ no known fix');
    expect(out).not.toContain('use recommended version');
  });

  it('orders upgrade options by descriptionCode priority and filters out VERSION_IN_USE and UNKNOWN', () => {
    const out = getFormattedTableWithReleases(
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
                  vulnerabilityIds: ['CVE-OTHER'],
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
            makeVulnIssue({
              vulnerabilityId: 'CVE-OTHER',
              versionOptions: [
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
    const fixLine = getLineWithText(out, 'Recommended versions without known vulnerabilities:');
    expect(fixLine).toContain('5.0.0 (latest)');
    expect(fixLine).toContain('4.0.0 (nearest)');
    expect(fixLine.indexOf('4.0.0')).toBeGreaterThan(fixLine.indexOf('5.0.0'));
    const partialRow = getLineWithText(out, '7.0.0 (fixes 1/2)');
    expect(partialRow).toContain('CVE-SORT');
    expect(out).not.toContain('9.0.0');
    expect(out).not.toContain('8.0.0');
  });

  it('caps the package Fix line at the two highest-priority complete-fix versions', () => {
    const out = getFormattedTableWithReleases(
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
    const fixLine = getLineWithText(out, 'Recommended versions without known vulnerabilities:');
    expect(fixLine).toContain('5.0.0 (latest stable)');
    expect(fixLine).toContain('3.0.0 (latest)');
    expect(fixLine).not.toContain('1.0.0');
    expect(fixLine).not.toContain('2.0.0');
    expect(fixLine).not.toContain('4.0.0');
    const latestStable = fixLine.indexOf('5.0.0');
    const latestComplete = fixLine.indexOf('3.0.0');
    expect(latestComplete).toBeGreaterThan(latestStable);
  });

  it('renders a via line for every chain when all chains have at least two entries', () => {
    const out = getFormattedTableWithReleases(
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
    const out = getFormattedTableWithReleases(
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
    const viaLines = out
      .split('\n')
      .filter((l) => l.trimStart().startsWith('via'))
      .map((l) => l.trimStart());
    expect(viaLines).toHaveLength(2);
    expect(viaLines[0]).toBe('via foo@1.0.0');
    expect(viaLines[1]).toContain('a@1');
    expect(viaLines[1]).toContain('b@2');
    expect(viaLines[1]).toContain('foo@1.0.0');
  });

  it('replaces chain purls with name@version looked up from the releases list', () => {
    const out = getFormattedTableWithReleases(
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
    const viaLine = getLineWithText(out, '→');
    expect(viaLine.trimStart()).toBe('via lodash@4.17.21 → foo@1.0.0');
  });

  it('keeps only the three shortest chains and appends "and via N others" for the rest', () => {
    const out = getFormattedTableWithReleases(
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
    const out = getFormattedTableWithReleases(
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
    const out = getFormattedTableWithReleases(
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
    expect(getLineWithText(out, 'alpha@1.0.0')).toContain('alpha@1.0.0');
    expect(getLineWithText(out, 'beta@2.0.0')).toContain('beta@2.0.0');
    expect(out).toContain('CVE-ALPHA');
    expect(out).toContain('CVE-BETA');
  });

  it('skips releases that have no issues', () => {
    const out = getFormattedTableWithReleases(
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

    const out = renderTable({ releases: [transit, foo], parsedFiles: [], errors: [] });

    expect(out).toContain('via transit@1.0.0 → foo@1.0.0');
  });

  it('renders every issue on a single line under the package block', () => {
    const out = getFormattedTableWithReleases(
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
    const cveLines = lines.filter((l) => l.includes('CVE-LAYOUT'));
    expect(cveLines).toHaveLength(1);
  });

  it('renders all issues without any truncation tail', () => {
    const out = getFormattedTableWithReleases(
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
    expect(out).toContain('CVE-4');
    expect(out).toContain('CVE-5');
    expect(out).not.toContain('more risks');
    expect(out).not.toContain('more');
  });

  it('emits a Fix line as the union of every COMPLETE-fix option across issues (deduped by version)', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-A',
              versionOptions: [
                {
                  version: '1.0.0',
                  vulnerabilityIds: ['CVE-A'],
                  prerelease: false,
                  fixLevel: 'NONE',
                  descriptionCode: 'VERSION_IN_USE',
                },
                {
                  version: '2.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'LATEST_STABLE',
                },
              ],
            }),
            makeVulnIssue({
              vulnerabilityId: 'CVE-B',
              versionOptions: [
                {
                  version: '1.0.0',
                  vulnerabilityIds: ['CVE-B'],
                  prerelease: false,
                  fixLevel: 'NONE',
                  descriptionCode: 'VERSION_IN_USE',
                },
                {
                  version: '1.5.0',
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
    const fixLine = getLineWithText(out, 'Recommended versions without known vulnerabilities:');
    // Union: a COMPLETE option with vulnerabilityIds=[] is package-safe at that
    // version, so versions from any issue qualify — no intersection required.
    expect(fixLine).toContain('2.0.0 (latest stable)');
    expect(fixLine).toContain('1.5.0 (nearest)');
  });

  it('deduplicates by version when the same COMPLETE-fix option appears on multiple issues', () => {
    const sharedFix: AnalyzeProjectIssue['versionOptions'] = [
      {
        version: '2.0.0',
        vulnerabilityIds: [],
        prerelease: false,
        fixLevel: 'COMPLETE',
        descriptionCode: 'LATEST_STABLE',
      },
    ];
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [
            makeVulnIssue({ vulnerabilityId: 'CVE-A', versionOptions: sharedFix }),
            makeVulnIssue({ vulnerabilityId: 'CVE-B', versionOptions: sharedFix }),
          ],
        }),
      ],
      1,
      [],
    );
    const fixLine = getLineWithText(out, 'Recommended versions without known vulnerabilities:');
    expect(fixLine.match(/2\.0\.0/g)).toHaveLength(1);
  });

  it('omits the Fix line when no vulnerability offers any COMPLETE fix', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-A',
              versionOptions: [
                {
                  version: '1.0.0',
                  vulnerabilityIds: ['CVE-A'],
                  prerelease: false,
                  fixLevel: 'NONE',
                  descriptionCode: 'VERSION_IN_USE',
                },
                {
                  version: '1.0.1',
                  vulnerabilityIds: ['CVE-A'],
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
    expect(out).not.toContain('Recommended versions without known vulnerabilities:');
  });

  it('computes the Fix line from vulnerabilities only, ignoring malware and license issues in the same release', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-A',
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
            makeMalwareIssue(),
            makeLicenseIssue(),
          ],
        }),
      ],
      1,
      [],
    );
    const fixLine = getLineWithText(out, 'Recommended versions without known vulnerabilities:');
    expect(fixLine).toContain('2.0.0');
  });

  it('omits the Fix line when the release contains only malware and license issues', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [makeMalwareIssue(), makeLicenseIssue()],
        }),
      ],
      1,
      [],
    );
    expect(out).not.toContain('Recommended versions without known vulnerabilities:');
  });

  it('appends → V (partial fix) inline when a vulnerability has a partial-fix option', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-PARTIAL',
              versionOptions: [
                {
                  version: '1.0.0',
                  vulnerabilityIds: ['CVE-PARTIAL'],
                  prerelease: false,
                  fixLevel: 'NONE',
                  descriptionCode: 'VERSION_IN_USE',
                },
                {
                  version: '1.0.1',
                  vulnerabilityIds: ['CVE-OTHER'],
                  prerelease: false,
                  fixLevel: 'PARTIAL',
                  descriptionCode: 'NEAREST_PARTIAL',
                },
              ],
            }),
            makeVulnIssue({
              vulnerabilityId: 'CVE-OTHER',
              versionOptions: null,
            }),
          ],
        }),
      ],
      1,
      [],
    );
    const row = getLineWithText(out, 'CVE-PARTIAL');
    expect(row).toContain('→ 1.0.1 (fixes 1/2)');
  });

  it('renders "→ use recommended version" when a vulnerability has only a complete-fix option', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-COMPLETE-ONLY',
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
    const row = getLineWithText(out, 'CVE-COMPLETE-ONLY');
    expect(row).toContain('→ use recommended version');
    expect(row).not.toContain('fixes');
  });

  it('appends "or use recommended version" when a vulnerability has both a partial and a complete fix', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-PARTIAL-AND-COMPLETE',
              versionOptions: [
                {
                  version: '1.0.1',
                  vulnerabilityIds: ['CVE-OTHER'],
                  prerelease: false,
                  fixLevel: 'PARTIAL',
                  descriptionCode: 'NEAREST_PARTIAL',
                },
                {
                  version: '2.0.0',
                  vulnerabilityIds: [],
                  prerelease: false,
                  fixLevel: 'COMPLETE',
                  descriptionCode: 'LATEST_STABLE',
                },
              ],
            }),
            makeVulnIssue({ vulnerabilityId: 'CVE-OTHER', versionOptions: null }),
          ],
        }),
      ],
      1,
      [],
    );
    const row = getLineWithText(out, 'CVE-PARTIAL-AND-COMPLETE');
    expect(row).toContain('→ 1.0.1 (fixes 1/2) or use recommended version');
  });

  it('picks the highest-priority partial-fix option for the inline tail', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-MANY-PARTIALS',
              versionOptions: [
                {
                  version: '1.5.0',
                  vulnerabilityIds: ['CVE-OTHER'],
                  prerelease: false,
                  fixLevel: 'PARTIAL',
                  descriptionCode: 'NEAREST_PARTIAL',
                },
                {
                  version: '1.9.0',
                  vulnerabilityIds: ['CVE-OTHER'],
                  prerelease: false,
                  fixLevel: 'PARTIAL',
                  descriptionCode: 'LATEST_PARTIAL',
                },
              ],
            }),
            makeVulnIssue({
              vulnerabilityId: 'CVE-OTHER',
              versionOptions: null,
            }),
          ],
        }),
      ],
      1,
      [],
    );
    const row = getLineWithText(out, 'CVE-MANY-PARTIALS');
    // LATEST_PARTIAL (rank 3) beats NEAREST_PARTIAL (rank 5) in DESCRIPTION_CODE_ORDER.
    expect(row).toContain('→ 1.9.0 (fixes 1/2)');
    expect(row).not.toContain('1.5.0');
  });

  it('prepends CVSS X.Y before the CVE id when cvssScore is set', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [makeVulnIssue({ vulnerabilityId: 'CVE-WITH-CVSS', cvssScore: '9.8' })],
        }),
      ],
      1,
      [],
    );
    const row = getLineWithText(out, 'CVE-WITH-CVSS');
    expect(row).toContain('CVSS 9.8 CVE-WITH-CVSS');
  });

  it('renders 10.0 as " 10" so the score column stays 3 chars wide', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [makeVulnIssue({ vulnerabilityId: 'CVE-TEN', cvssScore: '10.0' })],
        }),
      ],
      1,
      [],
    );
    const row = getLineWithText(out, 'CVE-TEN');
    expect(row).toContain('CVSS  10 CVE-TEN');
  });

  it('replaces the whole CVSS prefix with equivalent blank space when cvssScore is null', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [makeVulnIssue({ vulnerabilityId: 'CVE-NULL-SCORE', cvssScore: null })],
        }),
      ],
      1,
      [],
    );
    const row = getLineWithText(out, 'CVE-NULL-SCORE');
    expect(row).toContain('         CVE-NULL-SCORE');
    expect(row).not.toContain('CVSS');
  });

  it('renders the CVSS prefix before the id and the inline partial-fix tail after it', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              vulnerabilityId: 'CVE-CVSS-AND-PARTIAL',
              cvssScore: '7.5',
              versionOptions: [
                {
                  version: '1.0.1',
                  vulnerabilityIds: ['CVE-OTHER'],
                  prerelease: false,
                  fixLevel: 'PARTIAL',
                  descriptionCode: 'NEAREST_PARTIAL',
                },
              ],
            }),
            makeVulnIssue({ vulnerabilityId: 'CVE-OTHER', versionOptions: null }),
          ],
        }),
      ],
      1,
      [],
    );
    const row = getLineWithText(out, 'CVE-CVSS-AND-PARTIAL');
    expect(row).toContain('CVSS 7.5 CVE-CVSS-AND-PARTIAL → 1.0.1 (fixes 1/2)');
  });

  it('does not add a CVSS prefix to non-vulnerability rows even if cvssScore is set', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [
            makeMalwareIssue({ cvssScore: '9.0' }),
            makeLicenseIssue({ spdxLicenseId: 'AGPL-3.0', cvssScore: '8.0' }),
          ],
        }),
      ],
      1,
      [],
    );
    const malwareRow = getLineWithText(out, 'Malicious package');
    expect(malwareRow).not.toContain('CVSS');
    const licenseRow = getLineWithText(out, 'AGPL-3.0');
    expect(licenseRow).not.toContain('CVSS');
  });

  it('orders issues by type first (MALWARE → PROHIBITED_LICENSE → VULNERABILITY) within a release', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [
            makeVulnIssue({ severity: 'BLOCKER', vulnerabilityId: 'CVE-VULN' }),
            makeLicenseIssue({ severity: 'BLOCKER', spdxLicenseId: 'AGPL-3.0' }),
            makeMalwareIssue({ severity: 'BLOCKER' }),
          ],
        }),
      ],
      1,
      [],
    );
    const lines = out.split('\n');
    const malwareIdx = lines.findIndex((l) => l.includes('Malicious package'));
    const licenseIdx = lines.findIndex((l) => l.includes('AGPL-3.0'));
    const vulnIdx = lines.findIndex((l) => l.includes('CVE-VULN'));
    expect(malwareIdx).toBeGreaterThan(-1);
    expect(licenseIdx).toBeGreaterThan(malwareIdx);
    expect(vulnIdx).toBeGreaterThan(licenseIdx);
  });

  it('renders a short chain on a single via line without wrapping', () => {
    const out = getFormattedTableWithReleases(
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
    const viaLines = out.split('\n').filter((l) => l.trimStart().startsWith('via '));
    expect(viaLines).toHaveLength(1);
    expect(viaLines[0]).toContain('a@1');
    expect(viaLines[0]).toContain('b@2');
    expect(viaLines[0]).toContain('foo@1.0.0');
  });

  it('wraps a chain that exceeds 80 chars with "    → " continuation', () => {
    const long = '@scope-with-a-really-long-name/sub-package';
    const a = `${long}-aaaa`;
    const b = `${long}-bbbb`;
    const out = getFormattedTableWithReleases(
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
    // Long chain spills onto a continuation line: the second chain entry
    // ends up on a different line from the "via" prefix.
    const lines = out.split('\n');
    const viaLineIndex = lines.findIndex((l) => l.trimStart().startsWith('via '));
    expect(viaLineIndex).toBeGreaterThan(-1);
    expect(lines[viaLineIndex]).toContain(a);
    expect(lines[viaLineIndex]).not.toContain(b);
    expect(lines[viaLineIndex + 1]).toContain(b);
    expect(out).toContain('foo@1.0.0');
  });

  it('separates non-empty type groups with a blank line and attaches the fix line to the bottom of the vulnerability group', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [
            makeMalwareIssue({ severity: 'BLOCKER' }),
            makeLicenseIssue({ severity: 'HIGH', spdxLicenseId: 'AGPL-3.0' }),
            makeVulnIssue({
              vulnerabilityId: 'CVE-GROUPED',
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
    const malwareIdx = lines.findIndex((l) => l.includes('Malicious package'));
    const licenseIdx = lines.findIndex((l) => l.includes('AGPL-3.0'));
    const vulnIdx = lines.findIndex((l) => l.includes('CVE-GROUPED'));
    const malwareFooterIdx = lines.findIndex((l) =>
      l.includes('Remove this package and notify your information security team'),
    );
    const licenseFooterIdx = lines.findIndex((l) => l.includes('Review the license usage'));
    const fixIdx = lines.findIndex((l) =>
      l.includes('Recommended versions without known vulnerabilities:'),
    );

    expect(malwareIdx).toBeGreaterThan(-1);
    expect(licenseIdx).toBeGreaterThan(malwareIdx);
    expect(vulnIdx).toBeGreaterThan(licenseIdx);
    expect(malwareFooterIdx).toBe(malwareIdx + 1);
    expect(licenseFooterIdx).toBe(licenseIdx + 1);
    expect(fixIdx).toBe(vulnIdx + 1);

    expect(lines[malwareFooterIdx + 1]).toBe('');
    expect(lines[licenseIdx - 1]).toBe('');
    expect(lines[licenseFooterIdx + 1]).toBe('');
    expect(lines[vulnIdx - 1]).toBe('');
  });

  it('omits blank-line separators between absent groups and places the fix line on the line immediately after the last vulnerability row', () => {
    const out = getFormattedTableWithReleases(
      [
        makeRelease({
          issues: [
            makeVulnIssue({
              severity: 'HIGH',
              vulnerabilityId: 'CVE-ONLY',
              versionOptions: [
                {
                  version: '3.0.0',
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
    const vulnIdx = lines.findIndex((l) => l.includes('CVE-ONLY'));
    const fixIdx = lines.findIndex((l) =>
      l.includes('Recommended versions without known vulnerabilities:'),
    );
    expect(vulnIdx).toBeGreaterThan(-1);
    expect(fixIdx).toBe(vulnIdx + 1);
    expect(out).not.toContain('Malicious package');
    expect(out).not.toContain('AGPL-3.0');
  });

  describe('Summary block', () => {
    it('emits the Summary block on a clean scan with three zero rows', () => {
      const out = getFormattedTableWithReleases([], 0, []);
      const summaryIdx = out.indexOf('\nSummary:');
      expect(summaryIdx).toBeGreaterThan(-1);
      const summary = out.slice(summaryIdx);
      expect(summary).toContain('MALWARE');
      expect(summary).toContain('PROHIBITED_LICENSE');
      expect(summary).toContain('VULNERABILITY');
      // Every cell is zero on a clean scan. Counts are right-padded to 3
      // chars so columns stay aligned for up to 3-digit totals.
      for (const sev of ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW', 'INFO']) {
        expect(summary).toContain(`${sev} ✓   0`);
      }
    });

    it('renders the type rows in order MALWARE → PROHIBITED_LICENSE → VULNERABILITY', () => {
      const out = getFormattedTableWithReleases([], 0, []);
      const summary = out.slice(out.indexOf('\nSummary:'));
      const malwareIdx = summary.indexOf('MALWARE');
      const licenseIdx = summary.indexOf('PROHIBITED_LICENSE');
      const vulnIdx = summary.indexOf('VULNERABILITY');
      expect(malwareIdx).toBeGreaterThan(-1);
      expect(licenseIdx).toBeGreaterThan(malwareIdx);
      expect(vulnIdx).toBeGreaterThan(licenseIdx);
    });

    it('lays out all five severities in BLOCKER → INFO order on every row', () => {
      const out = getFormattedTableWithReleases([], 0, []);
      const summary = out.slice(out.indexOf('\nSummary:'));
      const rows = summary
        .split('\n')
        .filter((l) => /^\s{2}(MALWARE|PROHIBITED_LICENSE|VULNERABILITY)/.test(l));
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        const blocker = row.indexOf('BLOCKER');
        const high = row.indexOf('HIGH');
        const medium = row.indexOf('MEDIUM');
        const low = row.indexOf('LOW');
        const info = row.indexOf('INFO');
        expect(blocker).toBeGreaterThan(-1);
        expect(high).toBeGreaterThan(blocker);
        expect(medium).toBeGreaterThan(high);
        expect(low).toBeGreaterThan(medium);
        expect(info).toBeGreaterThan(low);
      }
    });

    it('counts each issue under its (type, severity) cell', () => {
      const out = getFormattedTableWithReleases(
        [
          makeRelease({
            issues: [
              makeVulnIssue({ severity: 'BLOCKER', vulnerabilityId: 'CVE-1' }),
              makeVulnIssue({ severity: 'BLOCKER', vulnerabilityId: 'CVE-2' }),
              makeVulnIssue({ severity: 'HIGH', vulnerabilityId: 'CVE-3' }),
              makeLicenseIssue({ severity: 'MEDIUM', spdxLicenseId: 'AGPL-3.0' }),
              makeMalwareIssue({ severity: 'BLOCKER' }),
            ],
          }),
        ],
        1,
        [],
      );
      const summary = out.slice(out.indexOf('\nSummary:'));
      const malwareRow = summary.split('\n').find((l) => l.trimStart().startsWith('MALWARE'));
      const licenseRow = summary
        .split('\n')
        .find((l) => l.trimStart().startsWith('PROHIBITED_LICENSE'));
      const vulnRow = summary.split('\n').find((l) => l.trimStart().startsWith('VULNERABILITY'));
      expect(malwareRow).toContain('BLOCKER ✗   1');
      expect(malwareRow).toContain('HIGH ✓   0');
      expect(licenseRow).toContain('MEDIUM ✗   1');
      expect(licenseRow).toContain('BLOCKER ✓   0');
      expect(vulnRow).toContain('BLOCKER ✗   2');
      expect(vulnRow).toContain('HIGH ✗   1');
      expect(vulnRow).toContain('MEDIUM ✓   0');
      expect(vulnRow).toContain('LOW ✓   0');
    });

    it('sums counts across multiple releases', () => {
      const out = getFormattedTableWithReleases(
        [
          makeRelease({
            packageName: 'a',
            issues: [
              makeVulnIssue({ severity: 'LOW', vulnerabilityId: 'CVE-A1' }),
              makeVulnIssue({ severity: 'LOW', vulnerabilityId: 'CVE-A2' }),
            ],
          }),
          makeRelease({
            packageName: 'b',
            packageUrl: 'pkg:npm/b@1.0.0',
            issues: [makeVulnIssue({ severity: 'LOW', vulnerabilityId: 'CVE-B1' })],
          }),
        ],
        2,
        [],
      );
      const vulnRow = out
        .slice(out.indexOf('\nSummary:'))
        .split('\n')
        .find((l) => l.trimStart().startsWith('VULNERABILITY'));
      expect(vulnRow).toContain('LOW ✗   3');
    });

    it('places the Summary block below the ═ separator and any Errors section', () => {
      const errors: AnalysisErrorResource[] = [
        { id: 'e1', code: 'UNKNOWN', path: null, message: 'oops' },
      ];
      const out = getFormattedTableWithReleases(
        [makeRelease({ issues: [makeVulnIssue()] })],
        1,
        errors,
      );
      const sepIdx = out.indexOf('═');
      const errorsIdx = out.indexOf('Errors:');
      const summaryIdx = out.indexOf('\nSummary:');
      expect(sepIdx).toBeGreaterThan(-1);
      expect(errorsIdx).toBeGreaterThan(sepIdx);
      expect(summaryIdx).toBeGreaterThan(errorsIdx);
    });
  });
});
