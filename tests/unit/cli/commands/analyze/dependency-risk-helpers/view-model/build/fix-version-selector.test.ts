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

import type { VersionOption } from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import {
  selectIssuePartialFixes,
  selectPackageCompleteFixes,
} from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/build';
import { mockVersionOption, mockVulnerabilityRisk } from './_helpers.ts';

describe('selectIssuePartialFixes', () => {
  it('returns only fixLevel=PARTIAL options', () => {
    const issue = mockVulnerabilityRisk({
      versionOptions: [
        mockVersionOption({
          version: '1.0.1',
          fixLevel: 'PARTIAL',
          descriptionCode: 'NEAREST_PARTIAL',
        }),
        mockVersionOption({
          version: '2.0.0',
          fixLevel: 'COMPLETE',
          descriptionCode: 'LATEST_STABLE',
        }),
        mockVersionOption({ version: '0.9.0', fixLevel: 'NONE', descriptionCode: 'LATEST_STABLE' }),
      ],
    });

    const fixes = selectIssuePartialFixes(issue);

    expect(fixes.map((f) => f.version)).toEqual(['1.0.1']);
  });

  it('excludes VERSION_IN_USE and UNKNOWN descriptionCodes even when fixLevel is PARTIAL', () => {
    const issue = mockVulnerabilityRisk({
      versionOptions: [
        mockVersionOption({
          version: '0.5.0',
          fixLevel: 'PARTIAL',
          descriptionCode: 'VERSION_IN_USE',
        }),
        mockVersionOption({ version: '0.6.0', fixLevel: 'PARTIAL', descriptionCode: 'UNKNOWN' }),
        mockVersionOption({
          version: '1.0.1',
          fixLevel: 'PARTIAL',
          descriptionCode: 'NEAREST_PARTIAL',
        }),
      ],
    });

    const fixes = selectIssuePartialFixes(issue);

    expect(fixes.map((f) => f.version)).toEqual(['1.0.1']);
  });

  it('sorts surviving options by descriptionCode priority', () => {
    // LATEST_PARTIAL (rank 3) beats NEAREST_PARTIAL (rank 5) per DESCRIPTION_CODE_ORDER
    const issue = mockVulnerabilityRisk({
      versionOptions: [
        mockVersionOption({
          version: '1.5.0',
          fixLevel: 'PARTIAL',
          descriptionCode: 'NEAREST_PARTIAL',
        }),
        mockVersionOption({
          version: '1.9.0',
          fixLevel: 'PARTIAL',
          descriptionCode: 'LATEST_PARTIAL',
        }),
      ],
    });

    const fixes = selectIssuePartialFixes(issue);

    expect(fixes.map((f) => f.version)).toEqual(['1.9.0', '1.5.0']);
  });

  it('returns [] when versionOptions is null', () => {
    expect(selectIssuePartialFixes(mockVulnerabilityRisk({ versionOptions: null }))).toEqual([]);
  });

  it('returns [] when versionOptions has no PARTIAL entries', () => {
    const issue = mockVulnerabilityRisk({
      versionOptions: [
        mockVersionOption({
          version: '2.0.0',
          fixLevel: 'COMPLETE',
          descriptionCode: 'LATEST_STABLE',
        }),
      ],
    });
    expect(selectIssuePartialFixes(issue)).toEqual([]);
  });

  it('preserves the source vulnerabilityIds on each FixVersionVM', () => {
    const issue = mockVulnerabilityRisk({
      versionOptions: [
        mockVersionOption({
          version: '1.0.1',
          fixLevel: 'PARTIAL',
          descriptionCode: 'NEAREST_PARTIAL',
          vulnerabilityIds: ['CVE-OTHER'],
        }),
      ],
    });

    expect(selectIssuePartialFixes(issue)[0].vulnerabilityIds).toEqual(['CVE-OTHER']);
  });
});

describe('selectPackageCompleteFixes', () => {
  it('returns only fixLevel=COMPLETE options', () => {
    const issues = [
      mockVulnerabilityRisk({
        versionOptions: [
          mockVersionOption({
            version: '2.0.0',
            fixLevel: 'COMPLETE',
            descriptionCode: 'LATEST_STABLE',
          }),
          mockVersionOption({
            version: '1.5.0',
            fixLevel: 'PARTIAL',
            descriptionCode: 'NEAREST_PARTIAL',
          }),
        ],
      }),
    ];

    const fixes = selectPackageCompleteFixes(issues);

    expect(fixes.map((f) => f.version)).toEqual(['2.0.0']);
  });

  it('excludes VERSION_IN_USE and UNKNOWN descriptionCodes even when fixLevel is COMPLETE', () => {
    const issues = [
      mockVulnerabilityRisk({
        versionOptions: [
          mockVersionOption({
            version: '1.0.0',
            fixLevel: 'COMPLETE',
            descriptionCode: 'VERSION_IN_USE',
          }),
          mockVersionOption({ version: '8.0.0', fixLevel: 'COMPLETE', descriptionCode: 'UNKNOWN' }),
          mockVersionOption({
            version: '5.0.0',
            fixLevel: 'COMPLETE',
            descriptionCode: 'LATEST_COMPLETE',
          }),
        ],
      }),
    ];

    const fixes = selectPackageCompleteFixes(issues);

    expect(fixes.map((f) => f.version)).toEqual(['5.0.0']);
  });

  it('dedupes by version when the same version appears across multiple issues', () => {
    const shared: VersionOption = mockVersionOption({
      version: '2.0.0',
      fixLevel: 'COMPLETE',
      descriptionCode: 'LATEST_STABLE',
    });
    const issues = [
      mockVulnerabilityRisk({ vulnerabilityId: 'CVE-A', versionOptions: [shared] }),
      mockVulnerabilityRisk({ vulnerabilityId: 'CVE-B', versionOptions: [shared] }),
    ];

    const fixes = selectPackageCompleteFixes(issues);

    expect(fixes.map((f) => f.version)).toEqual(['2.0.0']);
  });

  it('sorts surviving options by descriptionCode priority', () => {
    const issues = [
      mockVulnerabilityRisk({
        versionOptions: [
          mockVersionOption({
            version: '4.0.0',
            fixLevel: 'COMPLETE',
            descriptionCode: 'NEAREST_COMPLETE',
          }),
          mockVersionOption({
            version: '5.0.0',
            fixLevel: 'COMPLETE',
            descriptionCode: 'LATEST_COMPLETE',
          }),
          mockVersionOption({
            version: '3.0.0',
            fixLevel: 'COMPLETE',
            descriptionCode: 'LATEST_STABLE',
          }),
        ],
      }),
    ];

    const fixes = selectPackageCompleteFixes(issues);

    expect(fixes.map((f) => f.version)).toEqual(['3.0.0', '5.0.0', '4.0.0']);
  });

  it('unions across all issues — a COMPLETE option on any issue qualifies', () => {
    const issues = [
      mockVulnerabilityRisk({
        vulnerabilityId: 'CVE-A',
        versionOptions: [
          mockVersionOption({
            version: '2.0.0',
            fixLevel: 'COMPLETE',
            descriptionCode: 'LATEST_STABLE',
          }),
        ],
      }),
      mockVulnerabilityRisk({
        vulnerabilityId: 'CVE-B',
        versionOptions: [
          mockVersionOption({
            version: '1.5.0',
            fixLevel: 'COMPLETE',
            descriptionCode: 'NEAREST_COMPLETE',
          }),
        ],
      }),
    ];

    const fixes = selectPackageCompleteFixes(issues);

    expect(fixes.map((f) => f.version).sort()).toEqual(['1.5.0', '2.0.0']);
  });

  it('returns [] when no issue has a COMPLETE option', () => {
    const issues = [
      mockVulnerabilityRisk({
        versionOptions: [
          mockVersionOption({
            version: '1.0.1',
            fixLevel: 'PARTIAL',
            descriptionCode: 'NEAREST_PARTIAL',
          }),
          mockVersionOption({
            version: '1.0.0',
            fixLevel: 'NONE',
            descriptionCode: 'VERSION_IN_USE',
          }),
        ],
      }),
    ];

    expect(selectPackageCompleteFixes(issues)).toEqual([]);
  });

  it('returns [] for an empty issues array', () => {
    expect(selectPackageCompleteFixes([])).toEqual([]);
  });

  it('does not cap the number of fixes — every qualifying version is returned', () => {
    const issues = [
      mockVulnerabilityRisk({
        versionOptions: [
          mockVersionOption({
            version: '1.0.0',
            fixLevel: 'COMPLETE',
            descriptionCode: 'NEAREST_COMPLETE',
          }),
          mockVersionOption({
            version: '2.0.0',
            fixLevel: 'COMPLETE',
            descriptionCode: 'NEAREST_PARTIAL',
          }),
          mockVersionOption({
            version: '3.0.0',
            fixLevel: 'COMPLETE',
            descriptionCode: 'LATEST_COMPLETE',
          }),
          mockVersionOption({
            version: '4.0.0',
            fixLevel: 'COMPLETE',
            descriptionCode: 'LATEST_PARTIAL',
          }),
          mockVersionOption({
            version: '5.0.0',
            fixLevel: 'COMPLETE',
            descriptionCode: 'LATEST_STABLE',
          }),
        ],
      }),
    ];

    expect(selectPackageCompleteFixes(issues)).toHaveLength(5);
  });
});
