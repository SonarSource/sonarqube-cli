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

import { decode } from '@toon-format/toon';
import { describe, expect, it } from 'bun:test';

import { formatDependencyRisksToon } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/format-dependency-risks-toon.ts';
import { PackageIdentity } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model';
import {
  mockDependencyRisksViewModel,
  mockMalwareGroupVM,
  mockPackageVM,
  mockVulnerabilityGroupVM,
  mockVulnerabilityRiskVM,
  pkgId,
} from './_helpers.ts';

describe('formatDependencyRisksToon', () => {
  it('emits a non-empty TOON string containing the project key', () => {
    const out = formatDependencyRisksToon(
      'demo-project',
      mockDependencyRisksViewModel({ packages: [], packagesScanned: 0 }),
    );

    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('demo-project');
  });

  it('decode round-trips to an object with the expected project key and package fields', () => {
    const lodash = pkgId('pkg:npm/lodash@1.0.0');
    const pkg = mockPackageVM({
      package: lodash,
      chains: [[lodash]],
      groups: [
        mockVulnerabilityGroupVM({
          selectedRisks: [mockVulnerabilityRiskVM({ vulnerabilityId: 'CVE-1', cvssScore: '7.5' })],
        }),
      ],
    });
    const out = formatDependencyRisksToon(
      'demo',
      mockDependencyRisksViewModel({ packages: [pkg] }),
    );
    const decoded = decode(out) as Record<string, unknown>;

    expect(decoded['project']).toBe('demo');
    expect(Array.isArray(decoded['packages'])).toBe(true);
    expect(out).not.toContain('partialFixes');
  });

  it('serializes PackageIdentity as the bare purl string', () => {
    const lodash = pkgId('pkg:npm/lodash@1.0.0');
    const pkg = mockPackageVM({ package: lodash, chains: [[lodash]] });
    const out = formatDependencyRisksToon(
      'demo',
      mockDependencyRisksViewModel({ packages: [pkg] }),
    );

    expect(out).toContain('pkg:npm/lodash@1.0.0');
    expect(out).not.toContain('"name"');
    expect(out).not.toContain('"version"');
    expect(out).not.toContain('"ecosystem"');
  });

  it('flattens nested Maps — byType keys and per-package recommendation keys appear as TOON fields', () => {
    const pkg = mockPackageVM({
      package: new PackageIdentity('pkg:npm/mal@1.0.0', 'mal', '1.0.0', 'npm'),
      groups: [mockMalwareGroupVM()],
    });
    const out = formatDependencyRisksToon(
      'demo',
      mockDependencyRisksViewModel({ packages: [pkg] }),
    );

    expect(out).toContain('MALWARE');
    expect(out).toContain('REMOVE_PACKAGE');
  });
});
