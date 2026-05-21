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

import type { RiskPredicate } from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/risk-filter.ts';
import type { Severity } from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import { buildGroups } from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/build/group-builder.ts';
import type {
  RiskVM,
  VulnerabilityGroupVM,
  VulnerabilityRiskVM,
} from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/risk.ts';
import {
  mockLicenseRisk,
  mockMalwareRisk,
  mockScaRelease,
  mockVulnerabilityRisk,
} from './_helpers.ts';

const ALLOW_ALL: RiskPredicate = () => true;

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
  it('omits a group when the filter eliminates all of its risks', () => {
    const release = mockScaRelease({
      issues: [mockMalwareRisk(), mockVulnerabilityRisk()],
    });

    const groups = buildGroups(release, (_risk: RiskVM) => false);

    expect(groups).toEqual([]);
  });

  it('keeps the group when at least one risk survives the filter', () => {
    const release = mockScaRelease({
      issues: [
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-A', status: 'OPEN' }),
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-B', status: 'OPEN' }),
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-C', status: 'NEW' }),
      ],
    });

    const groups = buildGroups(release, (risk: RiskVM) => risk.status === 'NEW');

    expect(groups).toHaveLength(1);
    expect(groups[0].risks).toHaveLength(1);
  });
});

describe('buildGroups — severity ordering within a group', () => {
  it('sorts risks by severity (BLOCKER → INFO)', () => {
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

    const severities = groups[0].risks.map((r) => r.severity);
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

    const ids = (groups[0].risks as VulnerabilityRiskVM[]).map((r) => r.vulnerabilityId);
    expect(ids).toEqual(['CVE-HIGH', 'CVE-WAT']);
  });
});

describe('buildGroups — VULNERABILITY group carries packageFixes', () => {
  it('only the VULNERABILITY group has packageFixes; MALWARE and LICENSE do not', () => {
    const release = mockScaRelease({
      issues: [mockMalwareRisk(), mockLicenseRisk(), mockVulnerabilityRisk()],
    });

    const groups = buildGroups(release, ALLOW_ALL);

    const byType = Object.fromEntries(groups.map((g) => [g.type, g]));
    expect('packageFixes' in byType.MALWARE).toBe(false);
    expect('packageFixes' in byType.PROHIBITED_LICENSE).toBe(false);
    expect('packageFixes' in byType.VULNERABILITY).toBe(true);
  });

  it('populates packageFixes from the union of COMPLETE fix versions across the release vulnerabilities', () => {
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
    const versions = vulnGroup.packageFixes.map((f) => f.version);
    expect(versions).toContain('2.0.0');
    expect(versions).toContain('1.5.0');
  });

  it('packageFixes is empty when no vulnerability offers a COMPLETE fix', () => {
    const release = mockScaRelease({
      issues: [mockVulnerabilityRisk({ versionOptions: null })],
    });

    const groups = buildGroups(release, ALLOW_ALL);

    const vulnGroup = groups.find((g) => g.type === 'VULNERABILITY') as VulnerabilityGroupVM;
    expect(vulnGroup.packageFixes).toEqual([]);
  });
});
