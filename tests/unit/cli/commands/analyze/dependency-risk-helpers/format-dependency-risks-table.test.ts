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
import { formatDependencyRisksTable } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/table';
import { PackageIdentity } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model';
import { buildSummaryVM } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/build';
import {
  mockDependencyRisksViewModel,
  mockLicenseGroupVM,
  mockLicenseRiskVM,
  mockMalwareGroupVM,
  mockMalwareRiskVM,
  mockPackageVM,
  mockVulnerabilityGroupVM,
  mockVulnerabilityRiskVM,
  pkgId,
} from './_helpers.ts';

function lineWith(out: string, marker: string): string {
  const line = out.split('\n').find((l) => l.includes(marker));
  if (!line) throw new Error(`No line containing "${marker}" in:\n${out}`);
  return line;
}

describe('formatDependencyRisksTable — general smoke', () => {
  it('renders header, file paths, chain, issue rows, fix line, errors, and summary for a representative response', () => {
    const foo = new PackageIdentity('pkg:npm/foo@1.0.0', 'foo', '1.0.0', 'npm');
    const lodash = new PackageIdentity('pkg:npm/lodash@4.17.21', 'lodash', '4.17.21', 'npm');
    const pkg = mockPackageVM({
      package: foo,
      filePaths: ['package-lock.json'],
      chains: [[lodash, foo]],
      groups: [
        mockMalwareGroupVM(),
        mockLicenseGroupVM({ selectedRisks: [mockLicenseRiskVM({ spdxLicenseId: 'AGPL-3.0' })] }),
        mockVulnerabilityGroupVM({
          selectedRisks: [mockVulnerabilityRiskVM({ vulnerabilityId: 'CVE-1', cvssScore: '9.8' })],
          recommendation: {
            action: 'UPGRADE_PACKAGE',
            fixVersions: [
              { version: '2.0.0', descriptionCode: 'LATEST_STABLE', vulnerabilityIds: [] },
            ],
          },
        }),
      ],
    });
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({
        packages: [pkg],
        errors: [{ code: 'UNKNOWN', path: null, message: 'oops' }],
      }),
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
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({ packages: [], packagesScanned: 0 }),
    );
    expect(out).toContain('No dependency risks found.');
    expect(out).toContain('Summary:');
    expect(out).toContain('0 dependencies checked');
    expect(out).toContain('0 risks found');
  });

  it('shows the resolved filter inside the summary block', () => {
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({ packages: [], packagesScanned: 0 }),
    );
    expect(out).toContain('Filtering by: new, open, confirm, accept, safe, fixed');
    expect(out.indexOf('Summary:')).toBeLessThan(out.indexOf('Filtering by:'));
  });

  it('renders the discarded statuses alongside the kept ones when the filter excludes some', () => {
    const filter = buildRiskFilter('active')!.description;
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({
        packages: [],
        packagesScanned: 0,
        summary: buildSummaryVM([], 0, filter),
      }),
    );
    const filterLine = lineWith(out, 'Filtering by:');
    expect(filterLine).toContain('new, open, confirm');
    expect(filterLine).toContain('discarded: accept, safe, fixed');
    expect(filterLine.indexOf('new, open, confirm')).toBeLessThan(filterLine.indexOf('discarded:'));
  });
});

describe('package header', () => {
  it('uses singular "risk" for one issue', () => {
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({ packages: [mockPackageVM()] }),
    );
    const header = lineWith(out, 'lodash@4.17.21');
    expect(header).toContain('(1 risk)');
    expect(header).not.toContain('(1 risks)');
  });

  it('uses plural "risks" for more than one issue', () => {
    const pkg = mockPackageVM({
      groups: [
        mockVulnerabilityGroupVM({
          selectedRisks: [
            mockVulnerabilityRiskVM({ vulnerabilityId: 'CVE-A' }),
            mockVulnerabilityRiskVM({ vulnerabilityId: 'CVE-B' }),
          ],
        }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(lineWith(out, 'lodash@4.17.21')).toContain('(2 risks)');
  });

  it('adds [NEW] when the release is newly introduced', () => {
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({ packages: [mockPackageVM({ newlyIntroduced: true })] }),
    );
    expect(lineWith(out, 'lodash@4.17.21')).toContain('[NEW]');
  });
});

describe('file path line', () => {
  it('joins multiple file paths in the in: line', () => {
    const pkg = mockPackageVM({
      filePaths: ['package-lock.json', 'sub/package-lock.json'],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    const inLine = lineWith(out, 'in:');
    expect(inLine).toContain('package-lock.json');
    expect(inLine).toContain('sub/package-lock.json');
  });

  it('omits the in: line when there are no file paths', () => {
    const pkg = mockPackageVM({ filePaths: [] });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(out.split('\n').some((l) => l.trimStart().startsWith('in:'))).toBe(false);
  });
});

describe('dependency chain rendering', () => {
  it('keeps only the three shortest chains and appends "and via N others" for the rest', () => {
    const foo = pkgId('pkg:npm/foo@1.0.0');
    const pkg = mockPackageVM({
      package: foo,
      // pre-sorted shortest first, as the builder would produce
      chains: [
        [pkgId('pkg:npm/b1@1'), foo],
        [pkgId('pkg:npm/c1@1'), pkgId('pkg:npm/c2@1'), foo],
        [pkgId('pkg:npm/a1@1'), pkgId('pkg:npm/a2@1'), pkgId('pkg:npm/a3@1'), foo],
        [pkgId('pkg:npm/d1@1'), pkgId('pkg:npm/d2@1'), pkgId('pkg:npm/d3@1'), foo],
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    const viaLines = out.split('\n').filter((l) => l.trimStart().startsWith('via '));
    expect(viaLines).toHaveLength(3);
    expect(out).toContain('and via 1 others');
    expect(out).not.toContain('d1@1');
  });

  it('omits the "and via N others" tail when there are at most three chains', () => {
    const foo = pkgId('pkg:npm/foo@4.17.21');
    const pkg = mockPackageVM({
      package: foo,
      chains: [
        [pkgId('pkg:npm/a@1'), foo],
        [pkgId('pkg:npm/b@1'), foo],
        [pkgId('pkg:npm/c@1'), foo],
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(out).not.toContain('and via');
  });

  it('wraps a chain that exceeds 80 chars onto a continuation line beginning with →', () => {
    const base = '@scope-with-a-really-long-name/sub-package';
    const a = `${base}-aaaa`;
    const b = `${base}-bbbb`;
    const pkgA = new PackageIdentity(`pkg:npm/${a}@1.0.0`, a, '1.0.0', 'npm');
    const pkgB = new PackageIdentity(`pkg:npm/${b}@2.0.0`, b, '2.0.0', 'npm');
    const foo = new PackageIdentity('pkg:npm/foo@1.0.0', 'foo', '1.0.0', 'npm');
    const pkg = mockPackageVM({ package: foo, chains: [[pkgA, pkgB, foo]] });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
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
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({
        packages: [mockPackageVM({ groups: [mockMalwareGroupVM()] })],
      }),
    );
    expect(lineWith(out, 'Malicious package')).toContain('BLOCKER');
    expect(out).toContain('Remove this package and notify your information security team');
  });

  it('LICENSE rows show the spdxLicenseId and a review remediation footer', () => {
    const pkg = mockPackageVM({
      groups: [
        mockLicenseGroupVM({ selectedRisks: [mockLicenseRiskVM({ spdxLicenseId: 'AGPL-3.0' })] }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(lineWith(out, 'AGPL-3.0')).toContain('HIGH');
    expect(out).toContain('Review the license usage');
  });

  it('LICENSE rows fall back to release.licenseExpression when the issue has no spdxLicenseId', () => {
    const pkg = mockPackageVM({
      groups: [
        mockLicenseGroupVM({
          selectedRisks: [
            mockLicenseRiskVM({ spdxLicenseId: null, releaseLicenseExpression: 'AGPL-3.0' }),
          ],
        }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(lineWith(out, 'AGPL-3.0')).toContain('HIGH');
  });
});

describe('CVSS prefix on vulnerability rows', () => {
  it('prepends CVSS X.Y before the CVE id when cvssScore is set', () => {
    const pkg = mockPackageVM({
      groups: [
        mockVulnerabilityGroupVM({
          selectedRisks: [
            mockVulnerabilityRiskVM({ vulnerabilityId: 'CVE-WITH-CVSS', cvssScore: '9.8' }),
          ],
        }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(lineWith(out, 'CVE-WITH-CVSS')).toContain('CVSS 9.8 CVE-WITH-CVSS');
  });

  it('renders 10.0 as " 10" so the score column stays 3 chars wide', () => {
    const pkg = mockPackageVM({
      groups: [
        mockVulnerabilityGroupVM({
          selectedRisks: [
            mockVulnerabilityRiskVM({ vulnerabilityId: 'CVE-TEN', cvssScore: '10.0' }),
          ],
        }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(lineWith(out, 'CVE-TEN')).toContain('CVSS  10 CVE-TEN');
  });

  it('omits the CVSS prefix when cvssScore is null', () => {
    const pkg = mockPackageVM({
      groups: [
        mockVulnerabilityGroupVM({
          selectedRisks: [
            mockVulnerabilityRiskVM({ vulnerabilityId: 'CVE-NO-SCORE', cvssScore: null }),
          ],
        }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(lineWith(out, 'CVE-NO-SCORE')).not.toContain('CVSS');
  });

  it('does not add a CVSS prefix to non-vulnerability rows even when cvssScore is set on the issue', () => {
    const pkg = mockPackageVM({
      groups: [
        mockMalwareGroupVM({ selectedRisks: [mockMalwareRiskVM()] }),
        mockLicenseGroupVM({ selectedRisks: [mockLicenseRiskVM({ spdxLicenseId: 'AGPL-3.0' })] }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(lineWith(out, 'Malicious package')).not.toContain('CVSS');
    expect(lineWith(out, 'AGPL-3.0')).not.toContain('CVSS');
  });
});

describe('package fix line', () => {
  it('maps descriptionCode to display labels (latest stable, latest, nearest)', () => {
    const pkg = mockPackageVM({
      groups: [
        mockVulnerabilityGroupVM({
          recommendation: {
            action: 'UPGRADE_PACKAGE',
            fixVersions: [
              { version: '5.0.0', descriptionCode: 'LATEST_STABLE', vulnerabilityIds: [] },
              { version: '4.0.0', descriptionCode: 'LATEST_COMPLETE', vulnerabilityIds: [] },
            ],
          },
        }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    const fixLine = lineWith(out, 'Recommended versions without known vulnerabilities:');
    expect(fixLine).toContain('5.0.0 (latest stable)');
    expect(fixLine).toContain('4.0.0 (latest)');
  });

  it('labels NEAREST_COMPLETE as (nearest)', () => {
    const pkg = mockPackageVM({
      groups: [
        mockVulnerabilityGroupVM({
          recommendation: {
            action: 'UPGRADE_PACKAGE',
            fixVersions: [
              { version: '4.0.0', descriptionCode: 'NEAREST_COMPLETE', vulnerabilityIds: [] },
            ],
          },
        }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(lineWith(out, 'Recommended versions without known vulnerabilities:')).toContain(
      '4.0.0 (nearest)',
    );
  });

  it('caps the fix line at two versions (highest priority by descriptionCode)', () => {
    const pkg = mockPackageVM({
      groups: [
        mockVulnerabilityGroupVM({
          recommendation: {
            action: 'UPGRADE_PACKAGE',
            fixVersions: [
              { version: '5.0.0', descriptionCode: 'LATEST_STABLE', vulnerabilityIds: [] },
              { version: '3.0.0', descriptionCode: 'LATEST_COMPLETE', vulnerabilityIds: [] },
              { version: '1.0.0', descriptionCode: 'NEAREST_COMPLETE', vulnerabilityIds: [] },
            ],
          },
        }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    const fixLine = lineWith(out, 'Recommended versions without known vulnerabilities:');
    expect(fixLine).toContain('5.0.0');
    expect(fixLine).toContain('3.0.0');
    expect(fixLine).not.toContain('1.0.0');
  });

  it('shows "No recommended version" when no COMPLETE fix exists', () => {
    const pkg = mockPackageVM({
      groups: [
        mockVulnerabilityGroupVM({
          recommendation: { action: 'NO_FIX_AVAILABLE', fixVersions: [] },
        }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(out).toContain('No recommended version without known vulnerabilities');
    expect(out).not.toContain('Recommended versions without known vulnerabilities:');
  });

  it('omits the fix line when the release has no vulnerabilities (only malware/license)', () => {
    const pkg = mockPackageVM({
      groups: [mockMalwareGroupVM(), mockLicenseGroupVM()],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(out).not.toContain('Recommended versions without known vulnerabilities:');
    expect(out).not.toContain('No recommended version');
  });
});

describe('inline partial-fix tail on vulnerability rows', () => {
  it('appends "→ V (fixes M/N)" when only partial fixes are available', () => {
    const pkg = mockPackageVM({
      groups: [
        mockVulnerabilityGroupVM({
          selectedRisks: [
            mockVulnerabilityRiskVM({
              vulnerabilityId: 'CVE-PARTIAL',
              partialFixes: [
                {
                  version: '1.0.1',
                  descriptionCode: 'NEAREST_PARTIAL',
                  vulnerabilityIds: ['CVE-OTHER'],
                },
              ],
            }),
            mockVulnerabilityRiskVM({ vulnerabilityId: 'CVE-OTHER', partialFixes: [] }),
          ],
          recommendation: { action: 'NO_FIX_AVAILABLE', fixVersions: [] },
          totalKnownRisksCount: 2,
        }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(lineWith(out, 'CVE-PARTIAL')).toContain('→ 1.0.1 (fixes 1/2)');
  });

  it('renders no tail on a vulnerability when a COMPLETE fix exists for the release', () => {
    const pkg = mockPackageVM({
      groups: [
        mockVulnerabilityGroupVM({
          selectedRisks: [mockVulnerabilityRiskVM({ vulnerabilityId: 'CVE-COMPLETE-ONLY' })],
          recommendation: {
            action: 'UPGRADE_PACKAGE',
            fixVersions: [
              { version: '2.0.0', descriptionCode: 'LATEST_STABLE', vulnerabilityIds: [] },
            ],
          },
        }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    const row = lineWith(out, 'CVE-COMPLETE-ONLY');
    expect(row).not.toContain('→');
    expect(row).not.toContain('fixes');
  });

  it('renders "→ no fix available" when neither a partial nor complete fix exists for the release', () => {
    const pkg = mockPackageVM({
      groups: [
        mockVulnerabilityGroupVM({
          selectedRisks: [mockVulnerabilityRiskVM({ vulnerabilityId: 'CVE-NO-FIX' })],
          recommendation: { action: 'NO_FIX_AVAILABLE', fixVersions: [] },
        }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(lineWith(out, 'CVE-NO-FIX')).toContain('→ no fix available');
  });

  it('uses total (unfiltered) vulnerability count for the fixes fraction when some CVEs are hidden by the status filter', () => {
    // CVE-OPEN is visible; CVE-SAFE is hidden by the filter.
    // totalKnownRisksCount=2 reflects the unfiltered total so "fixes 1/2" is correct.
    const pkg = mockPackageVM({
      groups: [
        mockVulnerabilityGroupVM({
          selectedRisks: [
            mockVulnerabilityRiskVM({
              vulnerabilityId: 'CVE-OPEN',
              status: 'OPEN',
              partialFixes: [
                {
                  version: '1.0.1',
                  descriptionCode: 'NEAREST_PARTIAL',
                  vulnerabilityIds: ['CVE-SAFE'],
                },
              ],
            }),
          ],
          recommendation: { action: 'NO_FIX_AVAILABLE', fixVersions: [] },
          totalKnownRisksCount: 2,
        }),
      ],
    });
    const out = formatDependencyRisksTable(mockDependencyRisksViewModel({ packages: [pkg] }));
    expect(lineWith(out, 'CVE-OPEN')).toContain('→ 1.0.1 (fixes 1/2)');
  });
});

describe('errors section', () => {
  it('renders "[CODE] path: message" with a path and "[CODE] message" without', () => {
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({
        packages: [mockPackageVM()],
        errors: [
          { code: 'MISSING_LOCKFILE', path: 'app/', message: 'No lockfile' },
          { code: 'UNKNOWN', path: null, message: 'something' },
        ],
      }),
    );
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
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({
        packages: [],
        packagesScanned: 0,
        errors: [{ code: 'NO_DEPENDENCIES_FOUND', path: null, message: 'no deps' }],
      }),
    );
    expect(out).toContain('Errors:');
    expect(out).toContain('[NO_DEPENDENCIES_FOUND]');
    expect(out).toContain('No dependency risks found.');
  });
});

describe('summary block', () => {
  it('renders three type rows in MALWARE → PROHIBITED_LICENSE → VULNERABILITY order', () => {
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({ packages: [], packagesScanned: 0 }),
    );
    const summary = out.slice(out.indexOf('Summary:'));
    const malwareIdx = summary.indexOf('MALWARE');
    const licenseIdx = summary.indexOf('PROHIBITED_LICENSE');
    const vulnIdx = summary.indexOf('VULNERABILITY');
    expect(malwareIdx).toBeGreaterThan(-1);
    expect(licenseIdx).toBeGreaterThan(malwareIdx);
    expect(vulnIdx).toBeGreaterThan(licenseIdx);
  });

  it('lays out severities in BLOCKER → HIGH → MEDIUM → LOW → INFO order on every row', () => {
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({ packages: [], packagesScanned: 0 }),
    );
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
    const pkg = mockPackageVM({
      groups: [
        mockVulnerabilityGroupVM({
          selectedRisks: [
            mockVulnerabilityRiskVM({ severity: 'BLOCKER', vulnerabilityId: 'CVE-1' }),
          ],
        }),
      ],
    });
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({ packages: [pkg], packagesScanned: 1 }),
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
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({
        packages: [mockPackageVM()],
        errors: [{ code: 'UNKNOWN', path: null, message: 'oops' }],
      }),
    );
    expect(out.indexOf('Errors:')).toBeGreaterThan(-1);
    expect(out.indexOf('Summary:')).toBeGreaterThan(out.indexOf('Errors:'));
  });

  it('counts each issue under its (type, severity) cell, summing across releases', () => {
    const pkgA = mockPackageVM({
      package: new PackageIdentity('pkg:npm/a@1.0.0', 'a', '1.0.0', 'npm'),
      groups: [
        mockVulnerabilityGroupVM({
          selectedRisks: [
            mockVulnerabilityRiskVM({ severity: 'LOW', vulnerabilityId: 'CVE-A1' }),
            mockVulnerabilityRiskVM({ severity: 'LOW', vulnerabilityId: 'CVE-A2' }),
          ],
        }),
      ],
    });
    const pkgB = mockPackageVM({
      package: new PackageIdentity('pkg:npm/b@1.0.0', 'b', '1.0.0', 'npm'),
      groups: [
        mockVulnerabilityGroupVM({
          selectedRisks: [mockVulnerabilityRiskVM({ severity: 'LOW', vulnerabilityId: 'CVE-B1' })],
        }),
      ],
    });
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({ packages: [pkgA, pkgB], packagesScanned: 2 }),
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
    const mal = mockPackageVM({
      package: new PackageIdentity('pkg:npm/mal@1.0.0', 'mal', '1.0.0', 'npm'),
      groups: [mockMalwareGroupVM()],
    });
    const lic = mockPackageVM({
      package: new PackageIdentity('pkg:npm/lic@1.0.0', 'lic', '1.0.0', 'npm'),
      groups: [mockLicenseGroupVM()],
    });
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({ packages: [mal, lic], packagesScanned: 2 }),
    );
    const tail = out.slice(out.indexOf('Recommendations:'));
    expect(tail).toContain('Recommendations:');
    expect(tail).toContain('lic@1.0.0 (1 risk, highest severity HIGH)');
    expect(tail).toContain('mal@1.0.0 (1 risk, highest severity BLOCKER)');
    expect(tail).toContain('Remove this package and notify your information security team');
    expect(tail).toContain('Review the license usage');
  });

  it('pluralizes "risks" correctly and lists multiple recommendations under one package', () => {
    const pkg = mockPackageVM({
      package: new PackageIdentity('pkg:npm/mixed@1.0.0', 'mixed', '1.0.0', 'npm'),
      groups: [mockMalwareGroupVM(), mockLicenseGroupVM(), mockVulnerabilityGroupVM()],
    });
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({ packages: [pkg], packagesScanned: 1 }),
    );
    const tail = out.slice(out.indexOf('Recommendations:'));
    expect(tail).toContain('mixed@1.0.0 (3 risks, highest severity BLOCKER)');
    expect(tail).toContain('Remove this package and notify your information security team');
    expect(tail).toContain('Review the license usage');
    expect(tail).toContain('No recommended version without known vulnerabilities');
  });

  it('is omitted when no packages survived', () => {
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({ packages: [], packagesScanned: 0 }),
    );
    expect(out).not.toContain('Recommendations:');
  });

  it('places the Recommendations block after the Summary counts', () => {
    const out = formatDependencyRisksTable(
      mockDependencyRisksViewModel({ packages: [mockPackageVM()] }),
    );
    expect(out.indexOf('Recommendations:')).toBeGreaterThan(out.indexOf('Summary:'));
  });
});
