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
import { formatDependencyRisksJson } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/format-dependency-risks-json.ts';
import type {
  AnalyzeProjectRelease,
  AnalyzeProjectResponse,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';

function makeRelease(overrides: Partial<AnalyzeProjectRelease> = {}): AnalyzeProjectRelease {
  return {
    key: 'release-foo',
    packageUrl: 'pkg:npm/foo@1.0.0',
    packageManager: 'npm',
    packageName: 'foo',
    version: '1.0.0',
    licenseExpression: null,
    known: true,
    knownPackage: true,
    newlyIntroduced: false,
    issues: [],
    dependencyFilePaths: ['package-lock.json'],
    dependencyChains: [['pkg:npm/foo@1.0.0']],
    ...overrides,
  };
}

function makeResponse(overrides: Partial<AnalyzeProjectResponse> = {}): AnalyzeProjectResponse {
  return { releases: [], parsedFiles: [], errors: [], ...overrides };
}

function render(project: string, response: AnalyzeProjectResponse): string {
  return formatDependencyRisksJson(
    project,
    buildDependencyRisksViewModel(response, response.releases),
  );
}

describe('formatDependencyRisksJson', () => {
  it('emits the project key and the ViewModel fields as pretty-printed JSON', () => {
    const filtered = makeResponse({
      releases: [makeRelease({ packageName: 'lodash' })],
      errors: [{ id: 'e1', code: 'UNKNOWN', path: null, message: 'err' }],
    });

    const out = render('demo-project', filtered);
    const parsed = JSON.parse(out) as Record<string, unknown>;

    expect(parsed.project).toBe('demo-project');
    expect(parsed.packages).toEqual([]); // lodash has no issues → no package entry
    expect(parsed.errors).toEqual([{ code: 'UNKNOWN', path: null, message: 'err' }]);
    expect(parsed.summary).toMatchObject({ packagesScanned: 1, totalRisks: 0 });
    expect(out).toContain('\n  "project": "demo-project"');
  });

  it('serializes an empty response as an empty payload with the project key', () => {
    const out = render('demo', makeResponse());
    const parsed = JSON.parse(out) as Record<string, unknown>;

    expect(parsed.project).toBe('demo');
    expect(parsed.packages).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.summary).toMatchObject({ packagesScanned: 0, totalRisks: 0 });
  });

  it('serializes a release with issues into a package entry with risk groups', () => {
    const filtered = makeResponse({
      releases: [
        makeRelease({
          packageName: 'lodash',
          issues: [
            {
              key: 'i1',
              severity: 'HIGH',
              showIncreasedSeverityWarning: null,
              type: 'VULNERABILITY',
              quality: 'SECURITY',
              status: 'OPEN',
              vulnerabilityId: 'CVE-1',
              cweIds: null,
              cvssScore: '7.5',
              spdxLicenseId: null,
              versionOptions: null,
            },
          ],
        }),
      ],
    });

    const parsed = JSON.parse(render('demo', filtered)) as {
      packages: { name: string; version: string; groups: { type: string; risks: unknown[] }[] }[];
    };

    expect(parsed.packages).toHaveLength(1);
    expect(parsed.packages[0]).toMatchObject({ name: 'lodash', version: '1.0.0' });
    expect(parsed.packages[0].groups).toHaveLength(1);
    expect(parsed.packages[0].groups[0]).toMatchObject({ type: 'VULNERABILITY' });
  });
});
