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

import type { RiskFilterPredicate } from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/risk-filter.ts';
import type { Severity } from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import type {
  RiskVM,
  VulnerabilityGroupVM,
  VulnerabilityRiskVM,
} from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model';
import { buildGroups } from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/build';
import {
  mockLicenseRisk,
  mockMalwareRisk,
  mockScaRelease,
  mockVulnerabilityRisk,
} from './_helpers.ts';

const ALLOW_ALL: RiskFilterPredicate = () => true;

describe('buildGroups — type ordering', () => {
  it('returns groups in MALWARE → PROHIBITED_LICENSE → VULNERABILITY order regardless of source order', () => {
    const release = mockScaRelease({
      issues: [mockVulnerabilityRisk(), mockLicenseRisk(), mockMalwareRisk()],
    });

    const groups = buildGroups(release, ALLOW_ALL);

    expect(groups.map((g) => g.type)).toEqual(['MALWARE', 'PROHIBITED_LICENSE', 'VULNERABILITY']);
  });

  it('omits a type whose issues are empty', () => {
    const release = mockScaRelease({
      issues: [mockVulnerabilityRisk()],
    });

    const groups = buildGroups(release, ALLOW_ALL);

    expect(groups.map((g) => g.type)).toEqual(['VULNERABILITY']);
  });

  it('returns an empty array when the release has no issues', () => {
    const release = mockScaRelease({ issues: [] });

    expect(buildGroups(release, ALLOW_ALL)).toEqual([]);
  });
});

describe('buildGroups — filtering', () => {
  it('omits a group when the filter eliminates all of its selectedRisks', () => {
    const release = mockScaRelease({
      issues: [mockMalwareRisk(), mockVulnerabilityRisk()],
    });

    const groups = buildGroups(release, (_risk: RiskVM) => false);

    expect(groups).toEqual([]);
  });

  it('keeps the group when at least one risk survives the filter', () => {
    const release = mockScaRelease({
      newlyIntroduced: true,
      issues: [
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-A', status: 'OPEN' }),
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-B', status: 'OPEN' }),
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-C', status: null }),
      ],
    });

    const groups = buildGroups(release, (risk: RiskVM) => risk.status === 'NEW');

    expect(groups).toHaveLength(1);
    expect(groups[0].selectedRisks).toHaveLength(1);
  });
});

describe('buildGroups — severity ordering within a group', () => {
  it('sorts selectedRisks by severity (BLOCKER → INFO)', () => {
    const release = mockScaRelease({
      issues: [
        mockVulnerabilityRisk({ severity: 'LOW', vulnerabilityId: 'CVE-LOW' }),
        mockVulnerabilityRisk({ severity: 'BLOCKER', vulnerabilityId: 'CVE-BLOCK' }),
        mockVulnerabilityRisk({ severity: 'MEDIUM', vulnerabilityId: 'CVE-MED' }),
        mockVulnerabilityRisk({ severity: 'HIGH', vulnerabilityId: 'CVE-HIGH' }),
        mockVulnerabilityRisk({ severity: 'MEDIUM', vulnerabilityId: 'CVE-MED' }),
        mockVulnerabilityRisk({ severity: 'INFO', vulnerabilityId: 'CVE-INFO' }),
      ],
    });

    const groups = buildGroups(release, ALLOW_ALL);

    const severities = groups[0].selectedRisks.map((r) => r.severity);
    expect(severities).toEqual(['BLOCKER', 'HIGH', 'MEDIUM', 'MEDIUM', 'LOW', 'INFO']);
  });

  it('sinks unknown severities to the bottom of a group', () => {
    const release = mockScaRelease({
      issues: [
        mockVulnerabilityRisk({ severity: 'CATASTROPHIC' as Severity, vulnerabilityId: 'CVE-WAT' }),
        mockVulnerabilityRisk({ severity: 'HIGH', vulnerabilityId: 'CVE-HIGH' }),
      ],
    });

    const groups = buildGroups(release, ALLOW_ALL);

    const ids = (groups[0].selectedRisks as VulnerabilityRiskVM[]).map((r) => r.vulnerabilityId);
    expect(ids).toEqual(['CVE-HIGH', 'CVE-WAT']);
  });
});

describe('buildGroups — totalKnownRisksCount', () => {
  it('equals the number of issues in the group regardless of how many pass the filter', () => {
    const release = mockScaRelease({
      issues: [
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-A', status: 'OPEN' }),
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-B', status: 'SAFE' }),
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-C', status: 'SAFE' }),
      ],
    });

    const groups = buildGroups(release, (risk: RiskVM) => risk.status === 'OPEN');

    expect(groups).toHaveLength(1);
    expect(groups[0].selectedRisks).toHaveLength(1);
    expect(groups[0].totalKnownRisksCount).toBe(3);
  });

  it('equals selectedRisks.length when no issues are filtered out', () => {
    const release = mockScaRelease({
      issues: [
        mockMalwareRisk(),
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-A' }),
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-B' }),
      ],
    });

    const groups = buildGroups(release, ALLOW_ALL);

    for (const group of groups) {
      expect(group.totalKnownRisksCount).toBe(group.selectedRisks.length);
    }
  });
});

describe('buildGroups — recommendation', () => {
  it('attaches REMOVE_PACKAGE to MALWARE groups', () => {
    const release = mockScaRelease({ issues: [mockMalwareRisk()] });
    const groups = buildGroups(release, ALLOW_ALL);
    expect(groups[0].recommendation).toEqual({ action: 'REMOVE_PACKAGE', fixVersions: [] });
  });

  it('attaches REVIEW_LICENSE to PROHIBITED_LICENSE groups', () => {
    const release = mockScaRelease({ issues: [mockLicenseRisk()] });
    const groups = buildGroups(release, ALLOW_ALL);
    expect(groups[0].recommendation).toEqual({ action: 'REVIEW_LICENSE', fixVersions: [] });
  });

  it('attaches UPGRADE_PACKAGE with fixVersions when COMPLETE fixes exist', () => {
    const release = mockScaRelease({
      issues: [
        mockVulnerabilityRisk({
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
    });

    const groups = buildGroups(release, ALLOW_ALL);
    const vulnGroup = groups.find((g) => g.type === 'VULNERABILITY') as VulnerabilityGroupVM;

    expect(vulnGroup.recommendation.action).toBe('UPGRADE_PACKAGE');
    expect(vulnGroup.recommendation.fixVersions.map((f) => f.version)).toEqual(['2.0.0']);
  });

  it('populates UPGRADE_PACKAGE fixVersions from the union of COMPLETE fixes across vulnerabilities', () => {
    const release = mockScaRelease({
      issues: [
        mockVulnerabilityRisk({
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
        mockVulnerabilityRisk({
          vulnerabilityId: 'CVE-B',
          versionOptions: [
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
    });

    const groups = buildGroups(release, ALLOW_ALL);
    const vulnGroup = groups.find((g) => g.type === 'VULNERABILITY') as VulnerabilityGroupVM;

    const versions = vulnGroup.recommendation.fixVersions.map((f) => f.version);
    expect(versions).toContain('2.0.0');
    expect(versions).toContain('1.5.0');
  });

  it('attaches NO_FIX_AVAILABLE when the vulnerability group has no COMPLETE fixes', () => {
    const release = mockScaRelease({ issues: [mockVulnerabilityRisk({ versionOptions: null })] });
    const groups = buildGroups(release, ALLOW_ALL);
    const vulnGroup = groups.find((g) => g.type === 'VULNERABILITY') as VulnerabilityGroupVM;

    expect(vulnGroup.recommendation).toEqual({ action: 'NO_FIX_AVAILABLE', fixVersions: [] });
  });
});
