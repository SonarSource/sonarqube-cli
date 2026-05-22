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

import { buildRiskFilter } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/risk-filter.ts';
import type {
  AnalysisErrorResource,
  AnalyzeProjectRelease,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import { formatDependencyRisksTable } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/table/format-dependency-risks-table.ts';
import { buildDependencyRisksViewModel } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/build/build-dependency-risks-view-model.ts';
import {
  mockLicenseRisk,
  mockMalwareRisk,
  mockScaRelease,
  mockVulnerabilityRisk,
} from './view-model/build/_helpers.ts';

function renderTable(response: {
  releases: AnalyzeProjectRelease[];
  parsedFiles: string[];
  errors: AnalysisErrorResource[];
}): string {
  return formatDependencyRisksTable(
    buildDependencyRisksViewModel(response, buildRiskFilter('including-safe')),
  );
}

function render(
  releases: AnalyzeProjectRelease[],
  packagesScanned?: number,
  errors: AnalysisErrorResource[] = [],
): string {
  const withTargets = withChainTargetReleases(releases);
  const total = packagesScanned ?? withTargets.length;
  const padding = Math.max(0, total - withTargets.length);
  const padded = [
    ...withTargets,
    ...Array.from({ length: padding }, (_, i) =>
      mockScaRelease({
        key: `pad-${i}`,
        packageName: `pad${i}`,
        packageUrl: `pkg:pad/pad${i}@0.0.0`,
        version: '0.0.0',
        issues: [],
      }),
    ),
  ];
  return renderTable({ releases: padded, parsedFiles: [], errors });
}

function withChainTargetReleases(releases: AnalyzeProjectRelease[]): AnalyzeProjectRelease[] {
  const knownPurls = new Set(releases.map((r) => r.packageUrl));
  const stubs: AnalyzeProjectRelease[] = [];
  for (const release of releases) {
    for (const chain of release.dependencyChains) {
      for (const purl of chain) {
        if (knownPurls.has(purl)) continue;
        knownPurls.add(purl);
        const { packageManager, name, version } = parsePurl(purl);
        stubs.push(
          mockScaRelease({
            key: `stub-${purl}`,
            packageUrl: purl,
            packageManager,
            packageName: name,
            version,
            issues: [],
            dependencyChains: [],
          }),
        );
      }
    }
  }
  return [...releases, ...stubs];
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

function lineWith(out: string, marker: string): string {
  const line = out.split('\n').find((l) => l.includes(marker));
  if (!line) throw new Error(`No line containing "${marker}" in:\n${out}`);
  return line;
}

describe('formatDependencyRisksTable — general smoke', () => {
  it('renders header, file paths, chain, issue rows, fix line, errors, and summary for a representative response', () => {
    const out = render(
      [
        mockScaRelease({
          packageName: 'foo',
          version: '1.0.0',
          dependencyFilePaths: ['package-lock.json'],
          dependencyChains: [['pkg:npm/lodash@4.17.21', 'pkg:npm/foo@1.0.0']],
          issues: [
            mockMalwareRisk(),
            mockLicenseRisk({ spdxLicenseId: 'AGPL-3.0' }),
            mockVulnerabilityRisk({
              vulnerabilityId: 'CVE-1',
              cvssScore: '9.8',
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
      [{ id: 'e1', code: 'UNKNOWN', path: null, message: 'oops' }],
    );

    expect(out).toContain('foo@1.0.0');
    expect(out).toContain('package-lock.json');
    expect(out).toContain('lodash@4.17.21');
    expect(out).toContain('Malicious package');
    expect(out).toContain('AGPL-3.0');
    expect(out).toContain('CVE-1');
    expect(out).toContain('Recommended versions without known vulnerabilities:');
    expect(out).toContain('Errors:');
    expect(out).toContain('Summary:');
    // Relative ordering: header → groups → errors → summary.
    expect(out.indexOf('foo@1.0.0')).toBeLessThan(out.indexOf('Malicious package'));
    expect(out.indexOf('Malicious package')).toBeLessThan(out.indexOf('Errors:'));
    expect(out.indexOf('Errors:')).toBeLessThan(out.indexOf('Summary:'));
  });

  it('emits the clean-scan message when there are no risks and no errors', () => {
    const out = render([], 0, []);
    expect(out).toContain('No dependency risks found.');
    expect(out).toContain('Summary:');
    expect(out).toContain('0 dependencies checked');
    expect(out).toContain('0 risks found');
  });
});

describe('package header', () => {
  it('uses singular "risk" for one issue', () => {
    const out = render([mockScaRelease({ issues: [mockVulnerabilityRisk()] })], 1);
    const header = lineWith(out, 'lodash@4.17.21');
    expect(header).toContain('(1 risk)');
    expect(header).not.toContain('(1 risks)');
  });

  it('uses plural "risks" for more than one issue', () => {
    const out = render([
      mockScaRelease({
        issues: [
          mockVulnerabilityRisk({ vulnerabilityId: 'CVE-A' }),
          mockVulnerabilityRisk({ vulnerabilityId: 'CVE-B' }),
        ],
      }),
    ]);
    expect(lineWith(out, 'lodash@4.17.21')).toContain('(2 risks)');
  });

  it('adds [NEW] when the release is newly introduced', () => {
    const out = render([
      mockScaRelease({ newlyIntroduced: true, issues: [mockVulnerabilityRisk()] }),
    ]);
    expect(lineWith(out, 'lodash@4.17.21')).toContain('[NEW]');
  });
});

describe('file path line', () => {
  it('joins multiple file paths in the in: line', () => {
    const out = render([
      mockScaRelease({
        dependencyFilePaths: ['package-lock.json', 'sub/package-lock.json'],
        issues: [mockVulnerabilityRisk()],
      }),
    ]);
    const inLine = lineWith(out, 'in:');
    expect(inLine).toContain('package-lock.json');
    expect(inLine).toContain('sub/package-lock.json');
  });

  it('omits the in: line when there are no file paths', () => {
    const out = render([
      mockScaRelease({ dependencyFilePaths: [], issues: [mockVulnerabilityRisk()] }),
    ]);
    expect(out.split('\n').some((l) => l.trimStart().startsWith('in:'))).toBe(false);
  });
});

describe('dependency chain rendering', () => {
  it('keeps only the three shortest chains and appends "and via N others" for the rest', () => {
    const out = render([
      mockScaRelease({
        packageName: 'foo',
        version: '1.0.0',
        packageUrl: 'pkg:npm/foo@1.0.0',
        dependencyChains: [
          ['pkg:npm/a1@1', 'pkg:npm/a2@1', 'pkg:npm/a3@1', 'pkg:npm/foo@1.0.0'],
          ['pkg:npm/b1@1', 'pkg:npm/foo@1.0.0'],
          ['pkg:npm/c1@1', 'pkg:npm/c2@1', 'pkg:npm/foo@1.0.0'],
          ['pkg:npm/d1@1', 'pkg:npm/d2@1', 'pkg:npm/d3@1', 'pkg:npm/foo@1.0.0'],
        ],
        issues: [mockVulnerabilityRisk()],
      }),
    ]);
    const viaLines = out.split('\n').filter((l) => l.trimStart().startsWith('via '));
    expect(viaLines).toHaveLength(3);
    expect(out).toContain('and via 1 others');
    expect(out).not.toContain('d1@1');
  });

  it('omits the "and via N others" tail when there are at most three chains', () => {
    const out = render([
      mockScaRelease({
        dependencyChains: [
          ['pkg:npm/a@1', 'pkg:npm/foo@4.17.21'],
          ['pkg:npm/b@1', 'pkg:npm/foo@4.17.21'],
          ['pkg:npm/c@1', 'pkg:npm/foo@4.17.21'],
        ],
        packageName: 'foo',
        issues: [mockVulnerabilityRisk()],
      }),
    ]);
    expect(out).not.toContain('and via');
  });

  it('wraps a chain that exceeds 80 chars onto a continuation line beginning with →', () => {
    const long = '@scope-with-a-really-long-name/sub-package';
    const a = `${long}-aaaa`;
    const b = `${long}-bbbb`;
    const out = render([
      mockScaRelease({
        packageName: 'foo',
        version: '1.0.0',
        packageUrl: 'pkg:npm/foo@1.0.0',
        dependencyChains: [[`pkg:npm/${a}@1.0.0`, `pkg:npm/${b}@2.0.0`, 'pkg:npm/foo@1.0.0']],
        issues: [mockVulnerabilityRisk()],
      }),
    ]);
    const lines = out.split('\n');
    const viaIdx = lines.findIndex((l) => l.trimStart().startsWith('via '));
    expect(viaIdx).toBeGreaterThan(-1);
    expect(lines[viaIdx]).toContain(a);
    expect(lines[viaIdx]).not.toContain(b);
    expect(lines[viaIdx + 1].trimStart().startsWith('→')).toBe(true);
    expect(lines[viaIdx + 1]).toContain(b);
  });
});

describe('issue row labels', () => {
  it('MALWARE rows show "Malicious package" and a removal remediation footer', () => {
    const out = render([mockScaRelease({ issues: [mockMalwareRisk()] })]);
    expect(lineWith(out, 'Malicious package')).toContain('BLOCKER');
    expect(out).toContain('Remove this package and notify your information security team');
  });

  it('LICENSE rows show the spdxLicenseId and a review remediation footer', () => {
    const out = render([
      mockScaRelease({ issues: [mockLicenseRisk({ spdxLicenseId: 'AGPL-3.0' })] }),
    ]);
    expect(lineWith(out, 'AGPL-3.0')).toContain('HIGH');
    expect(out).toContain('Review the license usage');
  });

  it('LICENSE rows fall back to release.licenseExpression when the issue has no spdxLicenseId', () => {
    const out = render([
      mockScaRelease({
        licenseExpression: 'AGPL-3.0',
        issues: [mockLicenseRisk({ spdxLicenseId: null })],
      }),
    ]);
    expect(lineWith(out, 'AGPL-3.0')).toContain('HIGH');
  });
});

describe('CVSS prefix on vulnerability rows', () => {
  it('prepends CVSS X.Y before the CVE id when cvssScore is set', () => {
    const out = render([
      mockScaRelease({
        issues: [mockVulnerabilityRisk({ vulnerabilityId: 'CVE-WITH-CVSS', cvssScore: '9.8' })],
      }),
    ]);
    expect(lineWith(out, 'CVE-WITH-CVSS')).toContain('CVSS 9.8 CVE-WITH-CVSS');
  });

  it('renders 10.0 as " 10" so the score column stays 3 chars wide', () => {
    const out = render([
      mockScaRelease({
        issues: [mockVulnerabilityRisk({ vulnerabilityId: 'CVE-TEN', cvssScore: '10.0' })],
      }),
    ]);
    expect(lineWith(out, 'CVE-TEN')).toContain('CVSS  10 CVE-TEN');
  });

  it('omits the CVSS prefix when cvssScore is null', () => {
    const out = render([
      mockScaRelease({
        issues: [mockVulnerabilityRisk({ vulnerabilityId: 'CVE-NO-SCORE', cvssScore: null })],
      }),
    ]);
    expect(lineWith(out, 'CVE-NO-SCORE')).not.toContain('CVSS');
  });

  it('does not add a CVSS prefix to non-vulnerability rows even when cvssScore is set on the issue', () => {
    const out = render([
      mockScaRelease({
        issues: [
          mockMalwareRisk({ cvssScore: '9.0' }),
          mockLicenseRisk({ spdxLicenseId: 'AGPL-3.0', cvssScore: '8.0' }),
        ],
      }),
    ]);
    expect(lineWith(out, 'Malicious package')).not.toContain('CVSS');
    expect(lineWith(out, 'AGPL-3.0')).not.toContain('CVSS');
  });
});

describe('package fix line', () => {
  it('maps descriptionCode to display labels (latest stable, latest, nearest)', () => {
    const out = render([
      mockScaRelease({
        issues: [
          mockVulnerabilityRisk({
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
                descriptionCode: 'LATEST_COMPLETE',
              },
            ],
          }),
        ],
      }),
    ]);
    const fixLine = lineWith(out, 'Recommended versions without known vulnerabilities:');
    expect(fixLine).toContain('5.0.0 (latest stable)');
    expect(fixLine).toContain('4.0.0 (latest)');
  });

  it('labels NEAREST_COMPLETE as (nearest)', () => {
    const out = render([
      mockScaRelease({
        issues: [
          mockVulnerabilityRisk({
            versionOptions: [
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
    ]);
    expect(lineWith(out, 'Recommended versions without known vulnerabilities:')).toContain(
      '4.0.0 (nearest)',
    );
  });

  it('caps the fix line at two versions (highest priority by descriptionCode)', () => {
    const out = render([
      mockScaRelease({
        issues: [
          mockVulnerabilityRisk({
            versionOptions: [
              {
                version: '1.0.0',
                vulnerabilityIds: [],
                prerelease: false,
                fixLevel: 'COMPLETE',
                descriptionCode: 'NEAREST_COMPLETE',
              },
              {
                version: '3.0.0',
                vulnerabilityIds: [],
                prerelease: false,
                fixLevel: 'COMPLETE',
                descriptionCode: 'LATEST_COMPLETE',
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
    ]);
    const fixLine = lineWith(out, 'Recommended versions without known vulnerabilities:');
    expect(fixLine).toContain('5.0.0');
    expect(fixLine).toContain('3.0.0');
    expect(fixLine).not.toContain('1.0.0');
  });

  it('shows "No recommended version" when no COMPLETE fix exists', () => {
    const out = render([
      mockScaRelease({
        issues: [
          mockVulnerabilityRisk({
            versionOptions: [
              {
                version: '1.0.1',
                vulnerabilityIds: ['CVE-2024-0001'],
                prerelease: false,
                fixLevel: 'PARTIAL',
                descriptionCode: 'NEAREST_PARTIAL',
              },
            ],
          }),
        ],
      }),
    ]);
    expect(out).toContain('No recommended version without known vulnerabilities');
    expect(out).not.toContain('Recommended versions without known vulnerabilities:');
  });

  it('omits the fix line when the release has no vulnerabilities (only malware/license)', () => {
    const out = render([mockScaRelease({ issues: [mockMalwareRisk(), mockLicenseRisk()] })]);
    expect(out).not.toContain('Recommended versions without known vulnerabilities:');
    expect(out).not.toContain('No recommended version');
  });
});

describe('inline partial-fix tail on vulnerability rows', () => {
  it('appends "→ V (fixes M/N)" when only partial fixes are available', () => {
    const out = render([
      mockScaRelease({
        issues: [
          mockVulnerabilityRisk({
            vulnerabilityId: 'CVE-PARTIAL',
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
          mockVulnerabilityRisk({ vulnerabilityId: 'CVE-OTHER', versionOptions: null }),
        ],
      }),
    ]);
    expect(lineWith(out, 'CVE-PARTIAL')).toContain('→ 1.0.1 (fixes 1/2)');
  });

  it('renders no tail on a vulnerability when a COMPLETE fix exists for the release', () => {
    const out = render([
      mockScaRelease({
        issues: [
          mockVulnerabilityRisk({
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
    ]);
    const row = lineWith(out, 'CVE-COMPLETE-ONLY');
    expect(row).not.toContain('→');
    expect(row).not.toContain('fixes');
  });

  it('renders "→ no fix available" when neither a partial nor complete fix exists for the release', () => {
    const out = render([
      mockScaRelease({
        issues: [mockVulnerabilityRisk({ vulnerabilityId: 'CVE-NO-FIX', versionOptions: null })],
      }),
    ]);
    expect(lineWith(out, 'CVE-NO-FIX')).toContain('→ no fix available');
  });

  it('uses total (unfiltered) vulnerability count for the fixes fraction when some CVEs are hidden by the status filter', () => {
    // CVE-OPEN is visible; CVE-SAFE is hidden by the default 'open' filter.
    // The partial upgrade to 1.0.1 fixes CVE-OPEN but leaves CVE-SAFE → fixes 1 of 2 total.
    const releases = [
      mockScaRelease({
        issues: [
          mockVulnerabilityRisk({
            key: 'issue-open',
            vulnerabilityId: 'CVE-OPEN',
            status: 'OPEN',
            versionOptions: [
              {
                version: '1.0.1',
                vulnerabilityIds: ['CVE-SAFE'],
                prerelease: false,
                fixLevel: 'PARTIAL',
                descriptionCode: 'NEAREST_PARTIAL',
              },
            ],
          }),
          mockVulnerabilityRisk({
            key: 'issue-safe',
            vulnerabilityId: 'CVE-SAFE',
            status: 'SAFE',
            versionOptions: null,
          }),
        ],
      }),
    ];
    const withTargets = withChainTargetReleases(releases);
    const out = formatDependencyRisksTable(
      buildDependencyRisksViewModel(
        { releases: withTargets, parsedFiles: [], errors: [] },
        buildRiskFilter('open'),
      ),
    );
    expect(lineWith(out, 'CVE-OPEN')).toContain('→ 1.0.1 (fixes 1/2)');
  });
});

describe('errors section', () => {
  it('renders "[CODE] path: message" with a path and "[CODE] message" without', () => {
    const out = render([mockScaRelease({ issues: [mockVulnerabilityRisk()] })], 1, [
      { id: 'e1', code: 'MISSING_LOCKFILE', path: 'app/', message: 'No lockfile' },
      { id: 'e2', code: 'UNKNOWN', path: null, message: 'something' },
    ]);
    expect(out).toContain('Errors:');
    const withPath = lineWith(out, 'MISSING_LOCKFILE');
    expect(withPath).toContain('[MISSING_LOCKFILE]');
    expect(withPath).toContain('app/');
    expect(withPath).toContain('No lockfile');
    const withoutPath = lineWith(out, 'something');
    expect(withoutPath).toContain('[UNKNOWN]');
    expect(withoutPath).not.toContain(': something');
  });

  it('renders the Errors section even when there are no risks', () => {
    const out = render([], 0, [
      { id: 'e1', code: 'NO_DEPENDENCIES_FOUND', path: null, message: 'no deps' },
    ]);
    expect(out).toContain('Errors:');
    expect(out).toContain('[NO_DEPENDENCIES_FOUND]');
    expect(out).toContain('No dependency risks found.');
  });
});

describe('summary block', () => {
  it('renders three type rows in MALWARE → PROHIBITED_LICENSE → VULNERABILITY order', () => {
    const out = render([], 0);
    const summary = out.slice(out.indexOf('Summary:'));
    const malwareIdx = summary.indexOf('MALWARE');
    const licenseIdx = summary.indexOf('PROHIBITED_LICENSE');
    const vulnIdx = summary.indexOf('VULNERABILITY');
    expect(malwareIdx).toBeGreaterThan(-1);
    expect(licenseIdx).toBeGreaterThan(malwareIdx);
    expect(vulnIdx).toBeGreaterThan(licenseIdx);
  });

  it('lays out severities in BLOCKER → HIGH → MEDIUM → LOW → INFO order on every row', () => {
    const out = render([], 0);
    const summary = out.slice(out.indexOf('Summary:'));
    const rows = summary
      .split('\n')
      .filter((l) => /(MALWARE|PROHIBITED_LICENSE|VULNERABILITY)/.test(l));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const positions = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((s) => row.indexOf(s));
      expect(positions.every((p) => p > -1)).toBe(true);
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i]).toBeGreaterThan(positions[i - 1]);
      }
    }
  });

  it('marks zero-count cells with ✓ and non-zero cells with ✗', () => {
    const out = render(
      [
        mockScaRelease({
          issues: [mockVulnerabilityRisk({ severity: 'BLOCKER', vulnerabilityId: 'CVE-1' })],
        }),
      ],
      1,
    );
    const vulnRow = out
      .slice(out.indexOf('Summary:'))
      .split('\n')
      .find((l) => l.includes('VULNERABILITY'))!;
    const malwareRow = out
      .slice(out.indexOf('Summary:'))
      .split('\n')
      .find((l) => l.includes('MALWARE'))!;
    expect(vulnRow).toContain('BLOCKER ✗');
    expect(vulnRow).toContain('HIGH ✓');
    expect(malwareRow).toContain('BLOCKER ✓');
  });

  it('places the Summary block after any Errors section', () => {
    const out = render([mockScaRelease({ issues: [mockVulnerabilityRisk()] })], 1, [
      { id: 'e1', code: 'UNKNOWN', path: null, message: 'oops' },
    ]);
    expect(out.indexOf('Errors:')).toBeGreaterThan(-1);
    expect(out.indexOf('Summary:')).toBeGreaterThan(out.indexOf('Errors:'));
  });

  it('counts each issue under its (type, severity) cell, summing across releases', () => {
    const out = render(
      [
        mockScaRelease({
          packageName: 'a',
          issues: [
            mockVulnerabilityRisk({ severity: 'LOW', vulnerabilityId: 'CVE-A1' }),
            mockVulnerabilityRisk({ severity: 'LOW', vulnerabilityId: 'CVE-A2' }),
          ],
        }),
        mockScaRelease({
          packageName: 'b',
          issues: [mockVulnerabilityRisk({ severity: 'LOW', vulnerabilityId: 'CVE-B1' })],
        }),
      ],
      2,
    );
    const vulnRow = out
      .slice(out.indexOf('Summary:'))
      .split('\n')
      .find((l) => l.includes('VULNERABILITY'))!;
    expect(vulnRow).toContain('LOW ✗');
    expect(/LOW ✗\s+3/.test(vulnRow)).toBe(true);
  });
});

describe('recommendations summary block', () => {
  it('lists each package once with its risk count and per-type recommendations', () => {
    const out = render(
      [
        mockScaRelease({
          packageName: 'mal',
          version: '1.0.0',
          issues: [mockMalwareRisk()],
        }),
        mockScaRelease({
          packageName: 'lic',
          version: '1.0.0',
          issues: [mockLicenseRisk()],
        }),
      ],
      2,
    );
    const tail = out.slice(out.indexOf('Recommendations:'));
    expect(tail).toContain('Recommendations:');
    expect(tail).toContain('lic@1.0.0 (1 risk, highest severity HIGH)');
    expect(tail).toContain('mal@1.0.0 (1 risk, highest severity BLOCKER)');
    expect(tail).toContain('Remove this package and notify your information security team');
    expect(tail).toContain('Review the license usage');
  });

  it('pluralizes "risks" correctly and lists multiple recommendations under one package', () => {
    const out = render(
      [
        mockScaRelease({
          packageName: 'mixed',
          version: '1.0.0',
          issues: [mockMalwareRisk(), mockLicenseRisk(), mockVulnerabilityRisk()],
        }),
      ],
      1,
    );
    const tail = out.slice(out.indexOf('Recommendations:'));
    expect(tail).toContain('mixed@1.0.0 (3 risks, highest severity BLOCKER)');
    expect(tail).toContain('Remove this package and notify your information security team');
    expect(tail).toContain('Review the license usage');
    expect(tail).toContain('No recommended version without known vulnerabilities');
  });

  it('is omitted when no packages survived', () => {
    const out = render([], 0);
    expect(out).not.toContain('Recommendations:');
  });

  it('places the Recommendations block after the Summary counts', () => {
    const out = render([mockScaRelease({ issues: [mockVulnerabilityRisk()] })], 1);
    expect(out.indexOf('Recommendations:')).toBeGreaterThan(out.indexOf('Summary:'));
  });
});
