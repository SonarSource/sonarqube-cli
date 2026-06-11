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

import type { ScaScannerInvocation } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import {
  buildAnalyzeProjectArgs,
  buildDiscoverManifestsArgs,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner-args.ts';

function makeInvocation(overrides: Partial<ScaScannerInvocation> = {}): ScaScannerInvocation {
  return {
    baseDir: '/repo',
    apiBaseUrl: 'https://api.sonarcloud.io',
    downloadBaseUrl: 'https://download.sonarcloud.io/tidelift-cli',
    sonarToken: 'tok',
    projectKey: 'my-project',
    cacheDir: '/cache',
    workDir: '/work',
    scannerProperties: {},
    excludedPaths: [],
    includeGitIgnoredPaths: false,
    debug: false,
    ...overrides,
  };
}

describe('buildAnalyzeProjectArgs', () => {
  it('emits the fixed args in declared order', () => {
    expect(buildAnalyzeProjectArgs(makeInvocation())).toEqual([
      'analyze-project',
      '--base-dir=/repo',
      '--api-base-url=https://api.sonarcloud.io',
      '--download-base-url=https://download.sonarcloud.io/tidelift-cli',
      '--sonar-token=tok',
      '--cache-dir=/cache',
      '--work-dir=/work',
      '--project-key=my-project',
    ]);
  });

  it('repeats --scanner-property=name=value for each entry', () => {
    const args = buildAnalyzeProjectArgs(
      makeInvocation({ scannerProperties: { 'sonar.sca.foo': 'bar', 'sonar.sca.baz': '1,2' } }),
    );

    expect(args.filter((a) => a.startsWith('--scanner-property='))).toEqual([
      '--scanner-property=sonar.sca.foo=bar',
      '--scanner-property=sonar.sca.baz=1,2',
    ]);
  });

  it('repeats --excluded-path for each exclusion in input order', () => {
    const args = buildAnalyzeProjectArgs(
      makeInvocation({ excludedPaths: ['**/test/**', '**/dist/**'] }),
    );

    expect(args.filter((a) => a.startsWith('--excluded-path='))).toEqual([
      '--excluded-path=**/test/**',
      '--excluded-path=**/dist/**',
    ]);
  });

  it('emits --include-gitignored-paths only when the flag is true', () => {
    expect(
      buildAnalyzeProjectArgs(makeInvocation({ includeGitIgnoredPaths: false })),
    ).not.toContain('--include-gitignored-paths');
    expect(buildAnalyzeProjectArgs(makeInvocation({ includeGitIgnoredPaths: true }))).toContain(
      '--include-gitignored-paths',
    );
  });

  it('emits --debug only when the flag is true', () => {
    expect(buildAnalyzeProjectArgs(makeInvocation({ debug: false }))).not.toContain('--debug');
    expect(buildAnalyzeProjectArgs(makeInvocation({ debug: true }))).toContain('--debug');
  });
});

describe('buildDiscoverManifestsArgs', () => {
  it('emits the fixed args in declared order without --project-key', () => {
    expect(buildDiscoverManifestsArgs(makeInvocation())).toEqual([
      'discover-manifests',
      '--base-dir=/repo',
      '--api-base-url=https://api.sonarcloud.io',
      '--download-base-url=https://download.sonarcloud.io/tidelift-cli',
      '--sonar-token=tok',
      '--cache-dir=/cache',
      '--work-dir=/work',
    ]);
  });

  it('never emits --project-key even when a project key is set', () => {
    const args = buildDiscoverManifestsArgs(makeInvocation({ projectKey: 'my-project' }));
    expect(args.some((a) => a.startsWith('--project-key'))).toBe(false);
  });

  it('forwards scanner properties, exclusions, and flags like analyze-project', () => {
    const args = buildDiscoverManifestsArgs(
      makeInvocation({
        scannerProperties: { 'sonar.sca.foo': 'bar' },
        excludedPaths: ['**/dist/**'],
        includeGitIgnoredPaths: true,
        debug: true,
      }),
    );

    expect(args).toContain('--scanner-property=sonar.sca.foo=bar');
    expect(args).toContain('--excluded-path=**/dist/**');
    expect(args).toContain('--include-gitignored-paths');
    expect(args).toContain('--debug');
  });
});
