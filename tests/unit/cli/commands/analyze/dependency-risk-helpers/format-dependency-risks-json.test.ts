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

describe('formatDependencyRisksJson', () => {
  it('emits the project key and the filtered fields as pretty-printed JSON', () => {
    const filtered = makeResponse({
      releases: [makeRelease({ packageName: 'lodash' })],
      parsedFiles: ['package-lock.json'],
      errors: [{ id: 'e1', code: 'UNKNOWN', path: null, message: 'err' }],
    });

    const out = formatDependencyRisksJson('demo-project', filtered);

    expect(JSON.parse(out)).toEqual({
      project: 'demo-project',
      releases: filtered.releases,
      parsedFiles: filtered.parsedFiles,
      errors: filtered.errors,
    });
    expect(out).toContain('\n  "project": "demo-project"');
  });

  it('serializes an empty response as an empty payload with the project key', () => {
    const out = formatDependencyRisksJson('demo', makeResponse());

    expect(JSON.parse(out)).toEqual({
      project: 'demo',
      releases: [],
      parsedFiles: [],
      errors: [],
    });
  });
});
