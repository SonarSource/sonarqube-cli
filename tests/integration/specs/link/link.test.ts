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

// Integration tests for `sonar link`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SONARCLOUD_URL } from '@/core/config-constants.ts';

import { TestHarness } from '../../harness';

const SERVER_URL = 'https://sonarqube.example.com';

describe('sonar link', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('exits with code 1 and prompts to authenticate when no auth is configured', async () => {
    const result = await harness.run('link -p my_project --path .');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('Not authenticated');
  });

  it('exits with code 1 when not run inside a git repository', async () => {
    harness.withAuth(SERVER_URL, 'test-token');

    const result = await harness.run('link -p my_project --path .');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('No git repository found');
  });

  describe('inside a git repository', () => {
    beforeEach(() => {
      // findGitRoot() only checks for a `.git` dir/file — no real git repo needed.
      harness.cwd.writeFile('.git/.keep', '');
    });

    it('writes a Server entry derived from an on-premise connection', async () => {
      harness.withAuth(SERVER_URL, 'test-token');

      const result = await harness.run('link -p my_project --path .');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Added my_project to .sonar-config.json');
      expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
        project: { serverUrl: SERVER_URL, projectKey: 'my_project', path: '.' },
      });
    });

    it('writes a Cloud entry derived from a Cloud connection', async () => {
      harness.withAuth(SONARCLOUD_URL, 'test-token', 'my-org');

      const result = await harness.run('link -p my_project --path services/api');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
        project: {
          region: 'eu',
          organization: 'my-org',
          projectKey: 'my_project',
          path: 'services/api',
        },
      });
    });

    it('overwrites an existing entry rather than merging with it', async () => {
      harness.withAuth(SERVER_URL, 'test-token');
      harness.cwd.writeFile(
        '.sonar-config.json',
        JSON.stringify({
          project: {
            serverUrl: 'https://existing.example.com',
            projectKey: 'existing',
            path: 'a',
          },
        }),
      );

      const result = await harness.run('link -p my_project --path .');

      expect(result.exitCode).toBe(0);
      const file = harness.cwd.file('.sonar-config.json').asJson() as {
        project: { projectKey: string };
      };
      expect(file.project.projectKey).toBe('my_project');
    });

    it('fails when the Cloud connection URL does not resolve to a known region', async () => {
      // A 'cloud' connection type (inferred from the org) whose serverUrl isn't
      // a recognized SonarCloud host — cloudRegionFromUrl() can't derive a region.
      harness.withAuth('https://custom-cloud.example.com', 'test-token', 'my-org');

      const result = await harness.run('link -p my_project --path .');

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('region');
    });
  });
});
