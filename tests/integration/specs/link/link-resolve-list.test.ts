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

// Integration tests for `sonar link resolve` and `sonar link list`

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

describe('sonar link resolve and list', () => {
  let harness: TestHarness;

  function projectRoot(key: string): string {
    return join(harness.cwd.path, ...PROJECT_PATHS[key].split('/'));
  }

  function expectedProject(key: string) {
    return { projectKey: key, projectRoot: projectRoot(key), serverUrl: SERVER_URL };
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

  describe('resolve', () => {
    it('resolves the single project covering a nested file', async () => {
      const result = await harness.run('link resolve --path apps/web/src/index.ts');

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        path: join(projectRoot('web'), 'src', 'index.ts'),
        status: 'resolved',
        project: expectedProject('web'),
      });
    });

    it('defaults to the current directory', async () => {
      const result = await harness.run('link resolve', { cwd: projectRoot('docs') });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 'resolved',
        project: expectedProject('docs'),
      });
    });

    it('reports only a count of the projects nested under an ambiguous directory', async () => {
      const result = await harness.run('link resolve --path .');

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        path: harness.cwd.path,
        status: 'ambiguous',
        enclosingProjects: [],
        nestedProjectCount: 4,
      });
    });

    it('lists the enclosing projects when project directories are nested', async () => {
      const result = await harness.run('link resolve --path services/api/v2');

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        path: projectRoot('api-v2'),
        status: 'ambiguous',
        enclosingProjects: [expectedProject('api'), expectedProject('api-v2')],
        nestedProjectCount: 0,
      });
    });

    it('reports none for a directory outside every project', async () => {
      harness.cwd.writeFile('scripts/build.sh', '');

      const result = await harness.run('link resolve --path scripts');

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        path: join(harness.cwd.path, 'scripts'),
        status: 'none',
      });
    });

    it('rejects a path that does not exist', async () => {
      const result = await harness.run('link resolve --path missing');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Path "missing" does not exist.');
    });
  });

  describe('list', () => {
    function listedKeys(stdout: string): string[] {
      return (JSON.parse(stdout) as { projects: { projectKey: string }[] }).projects.map(
        (project) => project.projectKey,
      );
    }

    it('orders projects by distance from --near and pages through them', async () => {
      const firstPage = await harness.run('link list --near services/api --page-size 2');
      const secondPage = await harness.run('link list --near services/api --page-size 2 --page 2');

      expect(firstPage.exitCode).toBe(0);
      expect(listedKeys(firstPage.stdout)).toEqual(['api', 'api-v2']);
      expect(JSON.parse(firstPage.stdout).paging).toEqual({
        pageIndex: 1,
        pageSize: 2,
        total: 4,
        hasNextPage: true,
      });
      expect(listedKeys(secondPage.stdout)).toEqual(['docs', 'web']);
      expect(JSON.parse(secondPage.stdout).paging.hasNextPage).toBe(false);
    });

    it('filters by a case-insensitive --pattern on the key or directory', async () => {
      const byKey = await harness.run('link list --pattern "^API"');
      const byDirectory = await harness.run('link list --pattern apps');

      expect(listedKeys(byKey.stdout)).toEqual(['api', 'api-v2']);
      expect(listedKeys(byDirectory.stdout)).toEqual(['web']);
    });

    it('rejects an invalid --pattern', async () => {
      const result = await harness.run('link list --pattern "("');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Invalid --pattern option');
    });

    it('rejects a page size above the maximum', async () => {
      const result = await harness.run('link list --page-size 101');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Must be an integer between 1 and 100');
    });
  });

  it('still links a project key given as the first argument', async () => {
    const result = await harness.run('link my_project --path docs');

    expect(result.exitCode).toBe(0);
    expect(harness.cwd.file('.sonar-config.json').asJson()).toMatchObject({
      project: { serverUrl: SERVER_URL, projectKey: 'my_project', path: 'docs' },
    });
  });
});
