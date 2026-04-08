/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SONARCLOUD_URL } from '../../../../src/lib/config-constants';
import { loadSonarLintConfig } from '../../../../src/lib/project-workspace';
import { TestHarness } from '../../harness';

describe('SonarLint connected mode (harness)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function projectRoot(suffix: string): string {
    return join(harness.cwd.path, `proj-${suffix}-${Date.now()}`);
  }

  it(
    'SonarQube Server: connectedMode.json with sonarQubeUri and projectKey',
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

      const loaded = await loadSonarLintConfig(root);
      expect(loaded?.relativePath).toBe(join('.sonarlint', 'connectedMode.json'));
      expect(loaded?.config).toMatchObject({
        serverURL: 'https://sonarqube.example.com',
        projectKey: 'my_server_project',
        organization: '',
      });
    },
    { timeout: 15000 },
  );

  it(
    'SonarQube Cloud: connectedMode.json with sonarCloudOrganization and projectKey',
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

      const loaded = await loadSonarLintConfig(root);
      expect(loaded?.relativePath).toBe(join('.sonarlint', 'connectedMode.json'));
      expect(loaded?.config.serverURL).toBe(SONARCLOUD_URL);
      expect(loaded?.config.organization).toBe('my-org');
      expect(loaded?.config.projectKey).toBe('cloud_project_key');
    },
    { timeout: 15000 },
  );

  it(
    'solution-style JSON only (no connectedMode.json): loads MySolution.json',
    async () => {
      const root = projectRoot('solution');
      const sl = join(root, '.sonarlint');
      mkdirSync(sl, { recursive: true });
      writeFileSync(
        join(sl, 'MySolution.json'),
        JSON.stringify({
          sonarCloudOrganization: 'acme',
          projectKey: 'acme_solution',
        }),
      );

      const loaded = await loadSonarLintConfig(root);
      expect(loaded?.relativePath).toBe(join('.sonarlint', 'MySolution.json'));
      expect(loaded?.config.projectKey).toBe('acme_solution');
      expect(loaded?.config.organization).toBe('acme');
      expect(loaded?.config.serverURL).toBe(SONARCLOUD_URL);
    },
    { timeout: 15000 },
  );

  it(
    'no .sonarlint directory: returns null',
    async () => {
      const root = projectRoot('no-sonarlint');
      mkdirSync(root, { recursive: true });

      expect(await loadSonarLintConfig(root)).toBeNull();
    },
    { timeout: 15000 },
  );

  it(
    '.sonarlint exists but no connected mode / binding JSON: returns null',
    async () => {
      const root = projectRoot('empty-sonarlint');
      mkdirSync(join(root, '.sonarlint'), { recursive: true });
      writeFileSync(join(root, '.sonarlint', 'notes.txt'), 'not json');

      expect(await loadSonarLintConfig(root)).toBeNull();
    },
    { timeout: 15000 },
  );
});
