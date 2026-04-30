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

import { toDependencyRisks } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/dependency-risk.ts';
import type {
  ScaLicense,
  ScaPackage,
  ScaPackageInfoResponse,
  ScaVulnerability,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';

const DEFAULT_FILE_PATHS = ['package-lock.json'];
const DEFAULT_CHAINS = [['pkg:npm/lodash@4.17.21']];

function makeResponse(packages: ScaPackage[]): ScaPackageInfoResponse {
  return { packages, parsedFiles: [], errors: [] };
}

function makePackage(overrides: Partial<ScaPackage> = {}): ScaPackage {
  return {
    purl: 'pkg:npm/lodash@4.17.21',
    dependencyFilePaths: DEFAULT_FILE_PATHS,
    dependencyChains: DEFAULT_CHAINS,
    license: null,
    vulnerabilities: null,
    malicious: false,
    knownPackage: true,
    knownRelease: true,
    ...overrides,
  };
}

function makeVuln(overrides: Partial<ScaVulnerability> = {}): ScaVulnerability {
  return {
    id: 'CVE-2024-0001',
    cvssScore: 7.5,
    cweIds: ['CWE-79'],
    riskSeverity: 'HIGH',
    withdrawn: false,
    publishedOn: '2024-01-01',
    fixedVersions: [{ version: '1.2.3', fixLevel: 'safe', descriptionCode: 'upgrade_version' }],
    unaffectedVersions: ['0.9.0'],
    ...overrides,
  };
}

function license(allowed: boolean | null, expression = 'MIT'): ScaLicense {
  return { expression, allowed };
}

describe('toDependencyRisks', () => {
  it('returns empty array when there are no packages', () => {
    expect(toDependencyRisks(makeResponse([]))).toEqual([]);
  });

  it('emits one VULNERABILITY risk per vulnerability with id and cvssScore copied', () => {
    const pkg = makePackage({
      purl: 'pkg:npm/foo@1.0.0',
      dependencyFilePaths: ['package-lock.json'],
      dependencyChains: [['pkg:npm/foo@1.0.0']],
      vulnerabilities: [
        makeVuln({
          id: 'CVE-1',
          cvssScore: 9.8,
          riskSeverity: 'BLOCKER',
          cweIds: ['CWE-78'],
          publishedOn: '2024-02-15T11:15:00Z',
          fixedVersions: [
            { version: '1.0.1', fixLevel: 'safe', descriptionCode: 'upgrade_version' },
          ],
          unaffectedVersions: null,
        }),
      ],
    });

    const risks = toDependencyRisks(makeResponse([pkg]));

    expect(risks).toEqual([
      {
        packageName: 'pkg:npm/foo@1.0.0',
        type: 'VULNERABILITY',
        severity: 'BLOCKER',
        quality: 'SECURITY',
        status: 'OPEN',
        dependencyFilePaths: ['package-lock.json'],
        dependencyChains: [['pkg:npm/foo@1.0.0']],
        vulnerabilityId: 'CVE-1',
        cvssScore: 9.8,
        cweIds: ['CWE-78'],
        publishedOn: '2024-02-15T11:15:00Z',
        fixedVersions: [{ version: '1.0.1', fixLevel: 'safe', descriptionCode: 'upgrade_version' }],
        unaffectedVersions: null,
      },
    ]);
  });

  it('emits one risk per vulnerability when there are multiple', () => {
    const pkg = makePackage({
      purl: 'pkg:npm/foo@1.0.0',
      vulnerabilities: [
        makeVuln({ id: 'CVE-1', riskSeverity: 'LOW' }),
        makeVuln({ id: 'CVE-2', riskSeverity: 'HIGH' }),
        makeVuln({ id: 'CVE-3', riskSeverity: 'MEDIUM' }),
      ],
    });

    const risks = toDependencyRisks(makeResponse([pkg]));

    expect(risks).toHaveLength(3);
    expect(risks.map((r) => r.vulnerabilityId)).toEqual(['CVE-1', 'CVE-2', 'CVE-3']);
    expect(risks.map((r) => r.severity)).toEqual(['LOW', 'HIGH', 'MEDIUM']);
    for (const risk of risks) {
      expect(risk.packageName).toBe('pkg:npm/foo@1.0.0');
      expect(risk.type).toBe('VULNERABILITY');
    }
  });

  it('does not crash when vulnerabilities is null', () => {
    const pkg = makePackage({ vulnerabilities: null });
    expect(toDependencyRisks(makeResponse([pkg]))).toEqual([]);
  });

  it('filters out withdrawn vulnerabilities', () => {
    const pkg = makePackage({
      vulnerabilities: [makeVuln({ id: 'CVE-WITHDRAWN', withdrawn: true })],
    });

    expect(toDependencyRisks(makeResponse([pkg]))).toEqual([]);
  });

  it('emits only the non-withdrawn vulnerabilities when mixed', () => {
    const pkg = makePackage({
      vulnerabilities: [
        makeVuln({ id: 'CVE-LIVE-1', withdrawn: false }),
        makeVuln({ id: 'CVE-DEAD', withdrawn: true }),
        makeVuln({ id: 'CVE-LIVE-2', withdrawn: false }),
      ],
    });

    const risks = toDependencyRisks(makeResponse([pkg]));

    expect(risks.map((r) => r.vulnerabilityId)).toEqual(['CVE-LIVE-1', 'CVE-LIVE-2']);
  });

  it('emits a MALWARE risk with severity BLOCKER for malicious packages', () => {
    const pkg = makePackage({
      purl: 'pkg:npm/evil@0.0.1',
      malicious: true,
      dependencyFilePaths: ['package-lock.json'],
      dependencyChains: [['pkg:npm/evil@0.0.1']],
    });

    const risks = toDependencyRisks(makeResponse([pkg]));

    expect(risks).toEqual([
      {
        packageName: 'pkg:npm/evil@0.0.1',
        type: 'MALWARE',
        severity: 'BLOCKER',
        quality: 'SECURITY',
        status: 'OPEN',
        dependencyFilePaths: ['package-lock.json'],
        dependencyChains: [['pkg:npm/evil@0.0.1']],
      },
    ]);
  });

  it('emits a PROHIBITED_LICENSE risk carrying licenseExpression', () => {
    const pkg = makePackage({
      purl: 'pkg:npm/gpl-thing@2.0.0',
      license: license(false, 'GPL-3.0'),
      dependencyFilePaths: ['package-lock.json'],
      dependencyChains: [['pkg:npm/gpl-thing@2.0.0']],
    });

    const risks = toDependencyRisks(makeResponse([pkg]));

    expect(risks).toEqual([
      {
        packageName: 'pkg:npm/gpl-thing@2.0.0',
        type: 'PROHIBITED_LICENSE',
        severity: 'HIGH',
        quality: 'MAINTAINABILITY',
        status: 'OPEN',
        dependencyFilePaths: ['package-lock.json'],
        dependencyChains: [['pkg:npm/gpl-thing@2.0.0']],
        licenseExpression: 'GPL-3.0',
      },
    ]);
  });

  it('does not emit a license risk when license is null, allowed=true, or allowed=null', () => {
    const packages = [
      makePackage({ license: null }),
      makePackage({ license: license(true) }),
      makePackage({ license: license(null) }),
    ];

    expect(toDependencyRisks(makeResponse(packages))).toEqual([]);
  });

  it('emits malware, license, and vulnerability risks in that order for a package with all three', () => {
    const pkg = makePackage({
      purl: 'pkg:npm/triple-trouble@1.2.3',
      malicious: true,
      license: license(false, 'AGPL-3.0'),
      vulnerabilities: [
        makeVuln({ id: 'CVE-A', riskSeverity: 'MEDIUM' }),
        makeVuln({ id: 'CVE-B', riskSeverity: 'LOW' }),
      ],
    });

    const risks = toDependencyRisks(makeResponse([pkg]));

    expect(risks.map((r) => r.type)).toEqual([
      'MALWARE',
      'PROHIBITED_LICENSE',
      'VULNERABILITY',
      'VULNERABILITY',
    ]);
    expect(risks.map((r) => r.packageName)).toEqual([
      'pkg:npm/triple-trouble@1.2.3',
      'pkg:npm/triple-trouble@1.2.3',
      'pkg:npm/triple-trouble@1.2.3',
      'pkg:npm/triple-trouble@1.2.3',
    ]);
  });

  it('normalizes lowercase riskSeverity values to the enum', () => {
    const pkg = makePackage({
      vulnerabilities: [makeVuln({ riskSeverity: 'high' })],
    });

    expect(toDependencyRisks(makeResponse([pkg]))[0].severity).toBe('HIGH');
  });

  it('falls back to INFO for unknown riskSeverity values', () => {
    const pkg = makePackage({
      vulnerabilities: [makeVuln({ riskSeverity: 'CATASTROPHIC' })],
    });

    expect(toDependencyRisks(makeResponse([pkg]))[0].severity).toBe('INFO');
  });

  it('does not put vulnerability-only fields on malware or license risks', () => {
    const pkg = makePackage({
      malicious: true,
      license: license(false, 'GPL-3.0'),
    });

    const risks = toDependencyRisks(makeResponse([pkg]));

    for (const risk of risks) {
      expect(risk.vulnerabilityId).toBeUndefined();
      expect(risk.cvssScore).toBeUndefined();
      expect(risk.cweIds).toBeUndefined();
      expect(risk.publishedOn).toBeUndefined();
      expect(risk.fixedVersions).toBeUndefined();
      expect(risk.unaffectedVersions).toBeUndefined();
    }
  });

  it('does not put licenseExpression on malware or vulnerability risks', () => {
    const pkg = makePackage({
      malicious: true,
      license: license(false, 'GPL-3.0'),
      vulnerabilities: [makeVuln()],
    });

    const risks = toDependencyRisks(makeResponse([pkg]));
    const malware = risks.find((r) => r.type === 'MALWARE');
    const vuln = risks.find((r) => r.type === 'VULNERABILITY');

    expect(malware?.licenseExpression).toBeUndefined();
    expect(vuln?.licenseExpression).toBeUndefined();
  });
});
