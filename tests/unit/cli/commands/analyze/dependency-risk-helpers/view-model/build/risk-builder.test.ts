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
  buildLicenseRisk,
  buildMalwareRisk,
  buildVulnerabilityRisk,
} from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/build';
import {
  mockLicenseRisk,
  mockMalwareRisk,
  mockScaRelease,
  mockVulnerabilityRisk,
} from './_helpers.ts';

describe('effectiveStatus (exercised via buildVulnerabilityRisk)', () => {
  it('explicit status overrides the newlyIntroduced fallback', () => {
    const release = mockScaRelease({ newlyIntroduced: true });
    const risk = buildVulnerabilityRisk(release, mockVulnerabilityRisk({ status: 'OPEN' }));
    expect(risk.status).toBe('OPEN');
  });

  it("synthesizes 'NEW' for a null-status risk when the release is newlyIntroduced", () => {
    const release = mockScaRelease({ newlyIntroduced: true });
    const risk = buildVulnerabilityRisk(release, mockVulnerabilityRisk({ status: null }));
    expect(risk.status).toBe('NEW');
  });

  it("falls back to 'OPEN' for a null-status risk when the release is not newlyIntroduced", () => {
    const release = mockScaRelease({ newlyIntroduced: false });
    const risk = buildVulnerabilityRisk(release, mockVulnerabilityRisk({ status: null }));
    expect(risk.status).toBe('OPEN');
  });
});

describe('buildMalwareRisk', () => {
  it('carries severity and status only (no malware-specific fields)', () => {
    const release = mockScaRelease();
    const risk = buildMalwareRisk(release, mockMalwareRisk({ severity: 'BLOCKER' }));

    expect(risk).toEqual({ severity: 'BLOCKER', status: 'OPEN' });
  });
});

describe('buildLicenseRisk', () => {
  it('carries spdxLicenseId from the issue and releaseLicenseExpression from the release', () => {
    const release = mockScaRelease({ licenseExpression: 'GPL-3.0 OR MIT' });
    const risk = buildLicenseRisk(
      release,
      mockLicenseRisk({ severity: 'HIGH', spdxLicenseId: 'AGPL-3.0' }),
    );

    expect(risk).toEqual({
      severity: 'HIGH',
      status: 'OPEN',
      spdxLicenseId: 'AGPL-3.0',
      releaseLicenseExpression: 'GPL-3.0 OR MIT',
    });
  });

  it('preserves null spdxLicenseId — the renderer decides the fallback', () => {
    const release = mockScaRelease({ licenseExpression: 'AGPL-3.0' });
    const risk = buildLicenseRisk(release, mockLicenseRisk({ spdxLicenseId: null }));

    expect(risk.spdxLicenseId).toBeNull();
    expect(risk.releaseLicenseExpression).toBe('AGPL-3.0');
  });
});

describe('buildVulnerabilityRisk', () => {
  it('carries cvssScore, vulnerabilityId, and partialFixes', () => {
    const release = mockScaRelease();
    const risk = buildVulnerabilityRisk(
      release,
      mockVulnerabilityRisk({ vulnerabilityId: 'CVE-2024-0001', cvssScore: '9.8' }),
    );

    expect(risk.severity).toBe('HIGH');
    expect(risk.status).toBe('OPEN');
    expect(risk.cvssScore).toBe('9.8');
    expect(risk.vulnerabilityId).toBe('CVE-2024-0001');
    expect(risk.partialFixes).toEqual([]);
  });

  it('uses an empty string for vulnerabilityId when the issue has none', () => {
    const release = mockScaRelease();
    const risk = buildVulnerabilityRisk(release, mockVulnerabilityRisk({ vulnerabilityId: null }));

    expect(risk.vulnerabilityId).toBe('');
  });

  it('passes null cvssScore through unchanged', () => {
    const release = mockScaRelease();
    const risk = buildVulnerabilityRisk(release, mockVulnerabilityRisk({ cvssScore: null }));

    expect(risk.cvssScore).toBeNull();
  });

  it('populates partialFixes from the issue versionOptions (PARTIAL only)', () => {
    const release = mockScaRelease();
    const risk = buildVulnerabilityRisk(
      release,
      mockVulnerabilityRisk({
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
    );

    expect(risk.partialFixes.map((f) => f.version)).toEqual(['1.0.1']);
  });
});
