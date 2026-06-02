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
  buildPackageIdentityMap,
  buildPackageVM,
} from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/build';
import { mockScaRelease, mockVulnerabilityRisk } from './_helpers.ts';

const ALLOW_ALL = () => true;
const DENY_ALL = () => false;

describe('buildPackageIdentityMap', () => {
  it('maps every release purl to a PackageIdentity carrying its name, version, and packageManager', () => {
    const a = mockScaRelease({ packageName: 'a', version: '1.0.0', packageManager: 'npm' });
    const b = mockScaRelease({ packageName: 'b', version: '2.0.0', packageManager: 'pypi' });

    const map = buildPackageIdentityMap([a, b]);

    const idA = map.get(a.packageUrl)!;
    expect(idA.name).toBe('a');
    expect(idA.version).toBe('1.0.0');
    expect(idA.packageManager).toBe('npm');
    expect(idA.purl).toBe(a.packageUrl);
    const idB = map.get(b.packageUrl)!;
    expect(idB.name).toBe('b');
    expect(idB.packageManager).toBe('pypi');
  });

  it('last write wins when two releases share a purl', () => {
    const first = mockScaRelease({ packageName: 'shared', version: '1.0.0' });
    const second = mockScaRelease({
      packageName: 'shared',
      version: '1.0.0',
      packageManager: 'pypi',
    });

    const map = buildPackageIdentityMap([first, second]);

    expect(map.get(first.packageUrl)!.packageManager).toBe('pypi');
  });

  it('returns an empty map for no releases', () => {
    expect(buildPackageIdentityMap([])).toEqual(new Map());
  });
});

describe('buildPackageVM', () => {
  it('returns null when the filter eliminates every risk', () => {
    const release = mockScaRelease({ issues: [mockVulnerabilityRisk()] });
    const identityByPurl = buildPackageIdentityMap([release]);

    expect(buildPackageVM(release, DENY_ALL, identityByPurl)).toBeNull();
  });

  it('returns null when the release has no issues', () => {
    const release = mockScaRelease({ issues: [] });
    const identityByPurl = buildPackageIdentityMap([release]);

    expect(buildPackageVM(release, ALLOW_ALL, identityByPurl)).toBeNull();
  });

  it('sets riskCount to the sum of selectedRisks across surviving groups', () => {
    const release = mockScaRelease({
      issues: [
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-1' }),
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-2' }),
        mockVulnerabilityRisk({ vulnerabilityId: 'CVE-3' }),
      ],
    });
    const identityByPurl = buildPackageIdentityMap([release]);

    const pkg = buildPackageVM(release, ALLOW_ALL, identityByPurl)!;

    expect(pkg.riskCount).toBe(3);
  });

  it('propagates newlyIntroduced and filePaths from the release', () => {
    const release = mockScaRelease({
      newlyIntroduced: true,
      dependencyFilePaths: ['a/package-lock.json', 'b/package-lock.json'],
      issues: [mockVulnerabilityRisk()],
    });
    const identityByPurl = buildPackageIdentityMap([release]);

    const pkg = buildPackageVM(release, ALLOW_ALL, identityByPurl)!;

    expect(pkg.newlyIntroduced).toBe(true);
    expect(pkg.filePaths).toEqual(['a/package-lock.json', 'b/package-lock.json']);
  });

  it('reuses the PackageIdentity instance from the identity map', () => {
    const release = mockScaRelease({ issues: [mockVulnerabilityRisk()] });
    const identityByPurl = buildPackageIdentityMap([release]);

    const pkg = buildPackageVM(release, ALLOW_ALL, identityByPurl)!;

    expect(pkg.package).toBe(identityByPurl.get(release.packageUrl)!);
  });
});

describe('buildPackageVM — chain resolution', () => {
  it('resolves chain purls to PackageIdentity entries using the identity map', () => {
    const transit = mockScaRelease({ packageName: 'transit', version: '1.0.0' });
    const foo = mockScaRelease({
      packageName: 'foo',
      version: '2.0.0',
      dependencyChains: [['pkg:npm/transit@1.0.0', 'pkg:npm/foo@2.0.0']],
      issues: [mockVulnerabilityRisk()],
    });
    const identityByPurl = buildPackageIdentityMap([transit, foo]);

    const pkg = buildPackageVM(foo, ALLOW_ALL, identityByPurl)!;

    expect(pkg.chains).toHaveLength(1);
    expect(pkg.chains[0].map((id) => id.label())).toEqual(['transit@1.0.0', 'foo@2.0.0']);
  });

  it('drops a chain entirely when any purl in it is unknown', () => {
    const foo = mockScaRelease({
      packageName: 'foo',
      dependencyChains: [
        ['pkg:npm/known@1.0.0', 'pkg:npm/foo@4.17.21'],
        ['pkg:npm/missing@9.9.9', 'pkg:npm/foo@4.17.21'],
      ],
      issues: [mockVulnerabilityRisk()],
    });
    const known = mockScaRelease({ packageName: 'known', version: '1.0.0' });
    const identityByPurl = buildPackageIdentityMap([foo, known]);

    const pkg = buildPackageVM(foo, ALLOW_ALL, identityByPurl)!;

    expect(pkg.chains).toHaveLength(1);
    expect(pkg.chains[0].map((id) => id.label())).toEqual(['known@1.0.0', 'foo@4.17.21']);
  });

  it('orders resolved chains shortest-first', () => {
    const foo = mockScaRelease({
      packageName: 'foo',
      dependencyChains: [
        ['pkg:npm/a@1', 'pkg:npm/b@1', 'pkg:npm/foo@4.17.21'],
        ['pkg:npm/foo@4.17.21'],
        ['pkg:npm/c@1', 'pkg:npm/foo@4.17.21'],
      ],
      issues: [mockVulnerabilityRisk()],
    });
    const others = [
      mockScaRelease({ packageName: 'a', version: '1' }),
      mockScaRelease({ packageName: 'b', version: '1' }),
      mockScaRelease({ packageName: 'c', version: '1' }),
    ];
    const identityByPurl = buildPackageIdentityMap([foo, ...others]);

    const pkg = buildPackageVM(foo, ALLOW_ALL, identityByPurl)!;

    expect(pkg.chains.map((c) => c.length)).toEqual([1, 2, 3]);
  });

  it('preserves all chains — no cap at the builder layer', () => {
    const chains = Array.from({ length: 7 }, (_, i) => [
      `pkg:npm/dep${i}@1.0.0`,
      'pkg:npm/foo@4.17.21',
    ]);
    const foo = mockScaRelease({
      packageName: 'foo',
      dependencyChains: chains,
      issues: [mockVulnerabilityRisk()],
    });
    const deps = chains.map((_, i) => mockScaRelease({ packageName: `dep${i}`, version: '1.0.0' }));
    const identityByPurl = buildPackageIdentityMap([foo, ...deps]);

    const pkg = buildPackageVM(foo, ALLOW_ALL, identityByPurl)!;

    expect(pkg.chains).toHaveLength(7);
  });

  it('produces an empty chains list when the release declares no chains', () => {
    const release = mockScaRelease({ dependencyChains: [], issues: [mockVulnerabilityRisk()] });
    const identityByPurl = buildPackageIdentityMap([release]);

    const pkg = buildPackageVM(release, ALLOW_ALL, identityByPurl)!;

    expect(pkg.chains).toEqual([]);
  });
});
