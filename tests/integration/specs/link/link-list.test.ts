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

// Integration tests for `sonar link list`

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { initGitRepo } from '../hook/git-test-helpers.ts';

const SERVER_URL = 'https://sonarqube.example.com';

const PROJECT_PATHS: Record<string, string> = {
  api: 'services/api',
  'api-v2': 'services/api/v2',
  web: 'apps/web',
  docs: 'docs',
};

describe('sonar link list', () => {
  let harness: TestHarness;

  function projectRoot(key: string): string {
    return join(harness.cwd.path, ...PROJECT_PATHS[key].split('/'));
  }

  function expectedProject(key: string, contains: boolean) {
    return { projectKey: key, projectRoot: projectRoot(key), serverUrl: SERVER_URL, contains };
  }

  beforeEach(async () => {
    harness = await TestHarness.create();
    initGitRepo(harness.cwd.path);
    harness.withAuth(SERVER_URL, 'test-token');
    for (const path of Object.values(PROJECT_PATHS)) {
      harness.cwd.writeFile(`${path}/.keep`, '');
    }
    harness.cwd.writeFile('apps/web/src/index.ts', '');
    harness.cwd.writeFile(
      '.sonar-config.json',
      JSON.stringify({
        projects: Object.entries(PROJECT_PATHS).map(([projectKey, path]) => ({
          projectKey,
          path,
          serverUrl: SERVER_URL,
        })),
      }),
    );
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function listedKeys(stdout: string): string[] {
    return (JSON.parse(stdout) as { projects: { projectKey: string }[] }).projects.map(
      (project) => project.projectKey,
    );
  }

  it('lists the single project containing a file', async () => {
    const result = await harness.run('link list --path apps/web/src/index.ts');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      projects: [expectedProject('web', true)],
      paging: { pageIndex: 1, pageSize: 20, total: 1, hasNextPage: false },
    });
  });

  it('defaults to the current directory', async () => {
    const result = await harness.run('link list', { cwd: projectRoot('docs') });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).projects).toEqual([expectedProject('docs', true)]);
  });

  it('orders every project under --path by distance and pages through them', async () => {
    const firstPage = await harness.run('link list --path . --page-size 2');
    const secondPage = await harness.run('link list --path . --page-size 2 --page 2');

    expect(firstPage.exitCode).toBe(0);
    expect(listedKeys(firstPage.stdout)).toEqual(['docs', 'web']);
    expect(JSON.parse(firstPage.stdout).paging).toEqual({
      pageIndex: 1,
      pageSize: 2,
      total: 4,
      hasNextPage: true,
    });
    expect(listedKeys(secondPage.stdout)).toEqual(['api', 'api-v2']);
    expect(JSON.parse(secondPage.stdout).paging.hasNextPage).toBe(false);
  });

  it('flags enclosing projects apart from nested ones', async () => {
    const fromParent = await harness.run('link list --path services/api');
    const fromNested = await harness.run('link list --path services/api/v2');

    expect(JSON.parse(fromParent.stdout).projects).toEqual([
      expectedProject('api', true),
      expectedProject('api-v2', false),
    ]);
    expect(JSON.parse(fromNested.stdout).projects).toEqual([
      expectedProject('api-v2', true),
      expectedProject('api', true),
    ]);
  });

  it('lists nothing for a path outside every project', async () => {
    harness.cwd.writeFile('scripts/build.sh', '');

    const result = await harness.run('link list --path scripts/build.sh');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).projects).toEqual([]);
  });

  it('discovers projects from --path rather than the current directory', async () => {
    harness.cwd.writeFile('apps/web/ui/.keep', '');
    harness.cwd.writeFile(
      'apps/web/.sonar-config.json',
      JSON.stringify({ projects: [{ projectKey: 'web-ui', path: 'ui', serverUrl: SERVER_URL }] }),
    );

    const result = await harness.run('link list --path apps/web');

    expect(result.exitCode).toBe(0);
    expect(listedKeys(result.stdout)).toEqual(['web-ui']);
  });

  it('filters by a case-insensitive --pattern on the key or directory', async () => {
    const byKey = await harness.run('link list --pattern "^API"');
    const byDirectory = await harness.run('link list --pattern apps');

    expect(listedKeys(byKey.stdout)).toEqual(['api', 'api-v2']);
    expect(listedKeys(byDirectory.stdout)).toEqual(['web']);
  });

  it.each([
    ['--path missing', 'Path "missing" does not exist.'],
    ['--pattern "("', 'Invalid --pattern option'],
    ['--page-size 101', 'Must be an integer between 1 and 100'],
  ])('rejects %s', async (args, message) => {
    const result = await harness.run(`link list ${args}`);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(message);
  });
});
