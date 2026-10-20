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

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SONARCLOUD_URL, SONARCLOUD_US_URL } from '@/core/config-constants.ts';

import { TestHarness } from '../../harness';
import { initGitRepo } from '../hook/git-test-helpers.ts';

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
    const result = await harness.run('link my_project --path .');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('Not authenticated');
  });

  it('writes to the current directory and warns when not run inside a git repository', async () => {
    harness.withAuth(SERVER_URL, 'test-token');

    const result = await harness.run('link my_project --path .');

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain('No git repository found');
    // Nothing to commit outside a repository, so the sharing hint must not appear.
    expect(result.stdout).not.toContain('Commit .sonar-config.json to share it.');
    expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
      projects: [{ serverUrl: SERVER_URL, projectKey: 'my_project', path: '.' }],
    });
  });

  it('rejects an empty --path without writing anything', async () => {
    harness.withAuth(SERVER_URL, 'test-token');

    const result = await harness.run('link my_project --path " "');

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('--path must not be empty');
    expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
  });

  it('validates --path before warning about the missing git repository', async () => {
    harness.withAuth(SERVER_URL, 'test-token');

    const result = await harness.run('link my_project --path ../../../../etc');

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('must point to an existing directory inside');
    expect(result.stdout + result.stderr).not.toContain('No git repository found');
    expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
  });

  describe('inside a git repository', () => {
    beforeEach(() => {
      // resolveGitRepoRoot() shells out to `git rev-parse --show-toplevel`, so a real repo is required.
      initGitRepo(harness.cwd.path);
    });

    it('writes a Server entry derived from an on-premise connection', async () => {
      harness.withAuth(SERVER_URL, 'test-token');

      const result = await harness.run('link my_project --path .');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Linked ${harness.cwd.path} to project my_project`);
      expect(result.stdout).toContain(
        `Config saved to ${join(harness.cwd.path, '.sonar-config.json')}`,
      );
      expect(result.stdout).toContain('Commit .sonar-config.json to share it.');
      expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
        projects: [{ serverUrl: SERVER_URL, projectKey: 'my_project', path: '.' }],
      });
    });

    it('defaults --path to the repository root when omitted', async () => {
      harness.withAuth(SERVER_URL, 'test-token');

      const result = await harness.run('link my_project');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
        projects: [{ serverUrl: SERVER_URL, projectKey: 'my_project', path: '.' }],
      });
    });

    it('writes a Cloud entry derived from a Cloud connection', async () => {
      harness.withAuth(SONARCLOUD_URL, 'test-token', 'my-org');
      harness.cwd.writeFile('services/api/.keep', '');

      const result = await harness.run('link my_project --path services/api');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
        projects: [
          {
            region: 'eu',
            organization: 'my-org',
            projectKey: 'my_project',
            path: 'services/api',
          },
        ],
      });
    });

    it.each([
      [`${SONARCLOUD_URL}/`, 'eu'],
      [`${SONARCLOUD_US_URL}/`, 'us'],
      [`${SONARCLOUD_URL.toUpperCase()}/`, 'eu'],
    ] as const)('keeps a region entry for production Cloud URL %s', async (serverUrl, region) => {
      harness.withAuth(serverUrl, 'test-token', 'my-org');

      const result = await harness.run('link my_project --path .');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
        projects: [{ region, organization: 'my-org', projectKey: 'my_project', path: '.' }],
      });
    });

    it.each(['project', 'projects'] as const)(
      'preserves existing %s mappings and root fields when linking another directory',
      async (field) => {
        harness.withAuth(SERVER_URL, 'test-token');
        harness.cwd.writeFile('services/api/.keep', '');
        harness.cwd.writeFile('services/web/.keep', '');
        const original = {
          region: 'us',
          organization: 'acme',
          projectKey: 'web',
          path: 'services/web',
        };
        harness.cwd.writeFile(
          '.sonar-config.json',
          JSON.stringify({
            [field]: field === 'project' ? original : [original],
            custom: { keep: true },
          }),
        );

        const result = await harness.run('link api --path services/api');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
          custom: { keep: true },
          projects: [original, { projectKey: 'api', path: 'services/api', serverUrl: SERVER_URL }],
        });
      },
    );

    it.each(['services/api', './services/api/', 'services/web/../api'])(
      'updates the same directory without duplicates for path %s',
      async (path) => {
        harness.withAuth(SERVER_URL, 'test-token');
        harness.cwd.writeFile('services/api/.keep', '');
        harness.cwd.writeFile('services/web/.keep', '');
        expect((await harness.run('link api --path services/api')).exitCode).toBe(0);
        expect((await harness.run('link web --path services/web')).exitCode).toBe(0);

        const result = await harness.run(`link updated --path ${path}`);

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
          projects: [
            { projectKey: 'updated', path: 'services/api', serverUrl: SERVER_URL },
            { projectKey: 'web', path: 'services/web', serverUrl: SERVER_URL },
          ],
        });
      },
    );

    it.each(['project', 'projects'] as const)(
      'relinks the root binding from %s without duplication',
      async (field) => {
        harness.withAuth(SERVER_URL, 'test-token');
        const original = { projectKey: 'old', path: './', serverUrl: SERVER_URL };
        harness.cwd.writeFile(
          '.sonar-config.json',
          JSON.stringify({
            [field]: field === 'project' ? original : [original],
          }),
        );

        const result = await harness.run('link updated');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
          projects: [{ projectKey: 'updated', path: '.', serverUrl: SERVER_URL }],
        });
      },
    );

    it.each(['{ invalid', JSON.stringify({ projects: {} }), '[]'])(
      'does not overwrite malformed configuration %s',
      async (content) => {
        harness.withAuth(SERVER_URL, 'test-token');
        harness.cwd.writeFile('.sonar-config.json', content);

        const result = await harness.run('link api');

        expect(result.exitCode).not.toBe(0);
        expect(harness.cwd.file('.sonar-config.json').asText()).toBe(content);
      },
    );

    it('documents repeated directory linking in help', async () => {
      const result = await harness.run('link --help');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('sonar link api_project --path services/api');
      expect(result.stdout).toContain('preserves other mappings');
    });

    it.each(['https://sc-staging.io', `${SONARCLOUD_URL}:8443`])(
      'retains the Cloud URL %s in the shared configuration',
      async (serverUrl) => {
        harness.withAuth(serverUrl, 'test-token', 'my-org');

        const result = await harness.run('link my_project --path .');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
          projects: [{ serverUrl, organization: 'my-org', projectKey: 'my_project', path: '.' }],
        });
      },
    );

    it('fails when the Cloud connection URL host is not a known Cloud host', async () => {
      harness.withAuth('https://custom-cloud.example.com', 'test-token', 'my-org');

      const result = await harness.run('link my_project --path .');

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('SonarQube Cloud server URL host');
    });

    it('fails with a helpful message when --path escapes the repository root', async () => {
      harness.withAuth(SERVER_URL, 'test-token');

      const result = await harness.run('link my_project --path ../../../../etc');

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('must point to an existing directory inside');
      expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
    });
  });
});
