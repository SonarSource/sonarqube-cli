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
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SONARCLOUD_URL } from '../../../../src/lib/config-constants';
import {
  discoverOrganization,
  discoverProject,
  discoverProjectInfo,
  discoverServer,
} from '../../../../src/lib/project-workspace';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../src/ui';
import { TestHarness } from '../../harness';

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

describe('Project workspace + SonarLint (harness)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    setMockUi(true);
  });

  afterEach(async () => {
    clearMockUiCalls();
    setMockUi(false);
    await harness.dispose();
  });

  function projectRoot(suffix: string): string {
    return join(harness.cwd.path, `proj-${suffix}-${Date.now()}`);
  }

  it(
    'discoverProjectInfo and discoverProject read SonarQube Server binding from .sonarlint',
    async () => {
      const root = projectRoot('sq-server');
      mkdirSync(join(root, '.sonarlint'), { recursive: true });
      writeFileSync(
        join(root, '.sonarlint', 'connectedMode.json'),
        JSON.stringify({
          sonarQubeUri: 'https://sonarqube.example.com',
          projectKey: 'my_server_project',
        }),
      );

      const info = await discoverProjectInfo(root);
      expect(info.root).toBeDefined();
      expect(info.hasSonarLintConfig).toBe(true);
      expect(info.sonarLintConfigPath).toBe(join('.sonarlint', 'connectedMode.json'));
      expect(info.sonarLintData).toMatchObject({
        serverURL: 'https://sonarqube.example.com',
        projectKey: 'my_server_project',
      });
      expect(info.sonarLintData?.organization).toBeUndefined();

      const discovered = await discoverProject(root);
      expect(discovered.serverUrl).toBe('https://sonarqube.example.com');
      expect(discovered.projectKey).toBe('my_server_project');
      expect(discovered.organization).toBeUndefined();
      expect(discovered.configSources).toEqual([join('.sonarlint', 'connectedMode.json')]);
    },
    { timeout: 15000 },
  );

  it(
    'discoverProjectInfo and discoverProject read SonarQube Cloud binding from .sonarlint',
    async () => {
      const root = projectRoot('sq-cloud');
      mkdirSync(join(root, '.sonarlint'), { recursive: true });
      writeFileSync(
        join(root, '.sonarlint', 'connectedMode.json'),
        JSON.stringify({
          sonarCloudOrganization: 'my-org',
          projectKey: 'cloud_project_key',
        }),
      );

      const info = await discoverProjectInfo(root);
      expect(info.hasSonarLintConfig).toBe(true);
      expect(info.sonarLintData?.serverURL).toBe(SONARCLOUD_URL);
      expect(info.sonarLintData?.organization).toBe('my-org');
      expect(info.sonarLintData?.projectKey).toBe('cloud_project_key');

      const discovered = await discoverProject(root);
      expect(discovered.serverUrl).toBe(SONARCLOUD_URL);
      expect(discovered.organization).toBe('my-org');
      expect(discovered.projectKey).toBe('cloud_project_key');
    },
    { timeout: 15000 },
  );

  it(
    'discoverProject picks solution-style JSON when there is no connectedMode.json (any property name casing)',
    async () => {
      const root = projectRoot('solution');
      const sl = join(root, '.sonarlint');
      mkdirSync(sl, { recursive: true });
      writeFileSync(
        join(sl, 'MySolution.json'),
        JSON.stringify({
          SonarCloudOrganization: 'acme',
          ProjectKey: 'acme_solution',
        }),
      );

      const info = await discoverProjectInfo(root);
      expect(info.sonarLintConfigPath).toBe(join('.sonarlint', 'MySolution.json'));
      expect(info.sonarLintData?.projectKey).toBe('acme_solution');

      const discovered = await discoverProject(root);
      expect(discovered.projectKey).toBe('acme_solution');
      expect(discovered.organization).toBe('acme');
    },
    { timeout: 15000 },
  );

  it(
    'discoverProjectInfo reports no SonarLint config when .sonarlint is missing',
    async () => {
      const root = projectRoot('no-sonarlint');
      mkdirSync(root, { recursive: true });

      const info = await discoverProjectInfo(root);
      expect(info.hasSonarLintConfig).toBe(false);
      expect(info.sonarLintData).toBeNull();
      expect(info.sonarLintConfigPath).toBeNull();
    },
    { timeout: 15000 },
  );

  it(
    'discoverProjectInfo reports no SonarLint config when .sonarlint has no binding JSON',
    async () => {
      const root = projectRoot('empty-sonarlint');
      mkdirSync(join(root, '.sonarlint'), { recursive: true });
      writeFileSync(join(root, '.sonarlint', 'notes.txt'), 'not json');

      const info = await discoverProjectInfo(root);
      expect(info.hasSonarLintConfig).toBe(false);
      expect(info.sonarLintData).toBeNull();
    },
    { timeout: 15000 },
  );

  it(
    'discoverOrganization() uses process.cwd() and reads org from .sonarlint when properties omit it',
    async () => {
      const root = projectRoot('discover-org-cwd');
      mkdirSync(join(root, '.sonarlint'), { recursive: true });
      writeFileSync(
        join(root, '.sonarlint', 'connectedMode.json'),
        JSON.stringify({
          sonarCloudOrganization: 'from-lint-org',
          projectKey: 'k',
        }),
      );

      await withCwd(root, async () => {
        expect(await discoverOrganization()).toBe('from-lint-org');
      });
    },
    { timeout: 15000 },
  );

  it(
    'discoverServer() uses process.cwd() and reads server URL from SonarLint Server binding',
    async () => {
      const root = projectRoot('discover-server-cwd');
      mkdirSync(join(root, '.sonarlint'), { recursive: true });
      writeFileSync(
        join(root, '.sonarlint', 'connectedMode.json'),
        JSON.stringify({
          sonarQubeUri: 'https://sonarqube.from-lint.test',
          projectKey: 'pk',
        }),
      );

      await withCwd(root, async () => {
        expect(await discoverServer()).toBe('https://sonarqube.from-lint.test');
      });

      expect(
        getMockUiCalls().some(
          (c) =>
            c.method === 'print' && String(c.args[0]).includes('Found server in .sonarlint config'),
        ),
      ).toBe(true);
    },
    { timeout: 15000 },
  );
});
