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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../integration/harness';
import {
  createProject,
  deleteProject,
  STAGING_REGIONS,
  stagingConfig,
  uniqueProjectKey,
} from '../_common/staging';

const HOOK_TIMEOUT_MS = 30_000;

for (const region of STAGING_REGIONS) {
  const cfg = stagingConfig(region);

  describe.skipIf(!cfg.hasCredentials)(`staging auth path (${region})`, () => {
    let harness: TestHarness;
    let projectKey: string;

    beforeEach(async () => {
      harness = await TestHarness.create();
      projectKey = uniqueProjectKey('sonarqube-cli-its-auth');
      await createProject(cfg, projectKey);
    }, HOOK_TIMEOUT_MS);

    afterEach(async () => {
      if (projectKey) {
        await deleteProject(cfg, projectKey).catch((error) => {
          console.warn(`[staging-auth] teardown failed for project ${projectKey}: ${error}`);
        });
      }
      await harness?.dispose();
    }, HOOK_TIMEOUT_MS);

    it('logs in, links a project, and lists projects and issues through saved Cloud auth', async () => {
      const login = await harness.runWithStdin(
        `auth login --with-token --server ${cfg.serverUrl} --org ${cfg.org}`,
        `${cfg.token}\n`,
      );
      expect(login.exitCode).toBe(0);

      const connection = harness.stateJsonFile.asJson().auth.connections[0] as {
        type: string;
        orgKey: string;
      };
      expect(connection.type).toBe('cloud');
      expect(connection.orgKey).toBe(cfg.org);

      const projects = await harness.run(`list projects --query ${projectKey}`);
      expect(projects.exitCode).toBe(0);
      expect(
        (JSON.parse(projects.stdout) as { projects: Array<{ key: string }> }).projects.some(
          (project) => project.key === projectKey,
        ),
      ).toBe(true);

      const link = await harness.run(`link ${projectKey}`);
      expect(link.exitCode).toBe(0);
      expect(harness.cwd.file('.sonar-config.json').asJson().project).toMatchObject({
        serverUrl: cfg.serverUrl,
        organization: cfg.org,
        projectKey,
      });

      const issues = await harness.run(`list issues --project ${projectKey}`);
      expect(issues.exitCode).toBe(0);
      expect((JSON.parse(issues.stdout) as { issues: unknown[] }).issues).toBeArray();
    }, 60_000);
  });
}
