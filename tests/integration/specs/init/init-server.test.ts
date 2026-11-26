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

// Integration tests for bound-project creation on SonarQube Server.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  ENV_IMPORT_PAT_POLL_INTERVAL_MS,
  ENV_IMPORT_PAT_WAIT_TIMEOUT_MS,
} from '@/core/config-constants.ts';

import { type FakeSonarQubeServer, TestHarness } from '../../harness';
import { git, initGitRepo } from '../hook/git-test-helpers.ts';

const AZURE = {
  id: 'azure-id',
  key: 'my-azure',
  type: 'azure',
  url: 'https://dev.azure.com/example',
};
const OTHER = { ...AZURE, id: 'other-id', key: 'other-azure' };
const MISSING = { status: 400, message: "personal access token for 'my-azure' is missing" };
const TIMEOUT = { timeout: 30000 };
const ENV = {
  CI: 'false',
  SONARQUBE_CLI_MOCK_TTY: '1',
  [ENV_IMPORT_PAT_POLL_INTERVAL_MS]: '50',
  [ENV_IMPORT_PAT_WAIT_TIMEOUT_MS]: '10000',
};

describe('sonar init: Server binding', () => {
  let harness: TestHarness;
  beforeEach(async () => {
    harness = await TestHarness.create();
    initGitRepo(harness.cwd.path);
    git(
      ['remote', 'add', 'origin', 'https://dev.azure.com/example/project/_git/repository'],
      harness.cwd.path,
    );
  });
  afterEach(async () => {
    await harness.dispose();
  });

  async function start(
    configure: (s: ReturnType<TestHarness['newFakeServer']>) => void = () => {},
  ) {
    const builder = harness
      .newFakeServer()
      .withAuthToken('init-token')
      .withDopSettings([AZURE])
      .withAzureRepos(AZURE.key, [{ name: 'repository', projectName: 'project' }]);
    configure(builder);
    const server = await builder.start();
    harness.withAuth(server.baseUrl(), 'init-token');
    return server;
  }
  function creations(server: FakeSonarQubeServer) {
    return server
      .getRecordedRequests()
      .filter((r) => r.method === 'POST' && r.path === '/api/v2/dop-translation/bound-projects');
  }
  function expectNoCreation(server: FakeSonarQubeServer) {
    expect(creations(server)).toHaveLength(0);
    expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
  }

  it(
    'creates a bound project and saves its mapping without Cloud APIs or tokens',
    async () => {
      const server = await start();
      const result = await harness.run('init --bind --non-interactive');
      expect(result.exitCode).toBe(0);
      expect(creations(server)).toHaveLength(1);
      expect(JSON.parse(creations(server)[0].body!)).toMatchObject({
        projectKey: 'project_repository',
        devOpsPlatformSettingId: AZURE.id,
        repositoryIdentifier: 'repository',
        projectIdentifier: 'project',
      });
      const mapping = harness.cwd.file('.sonar-config.json').asText();
      expect(mapping).toContain('project_repository');
      expect(mapping).toContain(server.baseUrl());
      expect(mapping).not.toContain('init-token');
      expect(result.stdout).toContain('No analysis results yet');
      expect(server.getRecordedRequests().some((r) => r.path.includes('organizations'))).toBe(
        false,
      );
    },
    TIMEOUT,
  );

  it(
    'binds a GitHub remote through the Server backend',
    async () => {
      git(
        ['remote', 'set-url', 'origin', 'git@github.com:example/repository.git'],
        harness.cwd.path,
      );
      const server = await start((s) =>
        s
          .withDopSettings([
            { id: 'gh-id', key: 'my-github', type: 'github', url: 'https://github.com' },
          ])
          .withGithubOrganizations('my-github', [
            {
              key: 'example',
              repos: [
                {
                  id: 1,
                  key: 'example/repository',
                  name: 'repository',
                  url: 'https://github.com/example/repository',
                },
              ],
            },
          ]),
      );
      const result = await harness.run('init --bind --non-interactive');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(creations(server)[0].body!)).toMatchObject({
        projectKey: 'example_repository',
        devOpsPlatformSettingId: 'gh-id',
        repositoryIdentifier: 'example/repository',
      });
      expect(harness.cwd.file('.sonar-config.json').asText()).toContain('example_repository');
    },
    TIMEOUT,
  );

  it(
    'surfaces a permission failure instead of falling back',
    async () => {
      const server = await start((s) => s.withDopSettingsError(403));
      const session = harness.runInteractive('init', { extraEnv: ENV });
      await session.accept('Bind this repository');
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Create Projects');
      expectNoCreation(server);
    },
    TIMEOUT,
  );

  it(
    'does not reuse an existing project key whose repository binding differs',
    async () => {
      const server = await start((s) => s.withProject('project_repository'));
      const result = await harness.run('init --bind --non-interactive');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('project_repository');
      expectNoCreation(server);
    },
    TIMEOUT,
  );

  it(
    'uses init in the Azure repository-listing reconnect hint',
    async () => {
      const server = await start((s) => s.withAzureRepos(AZURE.key, []));
      const result = await harness.run('init --bind --non-interactive');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("run 'sonar init' again");
      expect(result.stderr).not.toContain('sonar import');
      expectNoCreation(server);
    },
    TIMEOUT,
  );

  it(
    'requires a setting key when several are configured without a terminal',
    async () => {
      const server = await start((s) => s.withDopSettings([OTHER, AZURE]));
      const result = await harness.run('init --bind --non-interactive');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--dop-setting <key>');
      expect(result.stderr).toContain('other-azure, my-azure');
      expectNoCreation(server);
    },
    TIMEOUT,
  );

  it(
    'uses the explicit setting key',
    async () => {
      const server = await start((s) => s.withDopSettings([OTHER, AZURE]));
      const result = await harness.run('init --bind --non-interactive --dop-setting my-azure');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(creations(server)[0].body!)).toMatchObject({
        devOpsPlatformSettingId: AZURE.id,
      });
    },
    TIMEOUT,
  );

  it(
    'lets the user select a setting and offers binding',
    async () => {
      const server = await start((s) => s.withDopSettings([OTHER, AZURE]));
      const session = harness.runInteractive('init', { extraEnv: ENV });
      await session.accept('Bind this repository');
      await session.waitText('Which DevOps platform');
      session.keyDown();
      session.keyEnter();
      await session.decline('Set up your coding agents');
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(creations(server)[0].body!)).toMatchObject({
        devOpsPlatformSettingId: AZURE.id,
      });
    },
    TIMEOUT,
  );

  for (const [name, configure, message] of [
    [
      'no integration',
      (s: ReturnType<TestHarness['newFakeServer']>) => s.withDopSettings([]),
      'No DevOps platform integration',
    ],
    [
      'old version',
      (s: ReturnType<TestHarness['newFakeServer']>) => s.withVersion('10.8.1'),
      '2025.1 or later',
    ],
    [
      'missing API',
      (s: ReturnType<TestHarness['newFakeServer']>) => s.withDopSettingsError(404),
      'settings API was not found',
    ],
  ] as const) {
    it(
      `falls back without binding for ${name}`,
      async () => {
        const server = await start(configure);
        const session = harness.runInteractive('init', { extraEnv: ENV });
        await session.accept('Bind this repository');
        await session.decline('Set up your coding agents');
        const result = await session.waitFinish();
        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain(message);
        expect(result.stdout + result.stderr).toContain('sonar init --link');
        expectNoCreation(server);
      },
      TIMEOUT,
    );
    it(
      `fails with --bind for ${name}`,
      async () => {
        const server = await start(configure);
        const result = await harness.run('init --bind --non-interactive');
        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain(message);
        expect(result.stdout + result.stderr).not.toContain('sonar import');
        expectNoCreation(server);
      },
      TIMEOUT,
    );
  }

  it(
    'previews token connection without opening the browser, listing repos, or creating a project',
    async () => {
      const server = await start((s) => s.withPatResponse(AZURE.key, MISSING));
      const result = await harness.run('init --bind --non-interactive --dry-run');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Would create a project bound');
      expect(result.stdout).toContain('token would first be connected');
      expect(server.getRecordedRequests().some((r) => r.path.includes('search_azure_repos'))).toBe(
        false,
      );
      expectNoCreation(server);
    },
    TIMEOUT,
  );

  it(
    'points noninteractive users to the token connection and init',
    async () => {
      const server = await start((s) => s.withPatResponse(AZURE.key, MISSING));
      const result = await harness.run('init --bind --non-interactive');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("run 'sonar init' again");
      expect(result.stderr).not.toContain('sonar import');
      expectNoCreation(server);
    },
    TIMEOUT,
  );

  for (const explicit of [false, true]) {
    it(
      `handles declined token consent (explicit bind: ${explicit})`,
      async () => {
        const server = await start((s) => s.withPatResponse(AZURE.key, MISSING));
        const session = harness.runInteractive(explicit ? 'init --bind' : 'init', {
          extraEnv: ENV,
        });
        if (!explicit) await session.accept('Bind this repository');
        await session.decline('Connect your DevOps platform personal access token');
        await session.decline('Set up your coding agents');
        const result = await session.waitFinish();
        expect(result.exitCode).toBe(0);
        expectNoCreation(server);
        expect(
          server.getRecordedRequests().filter((r) => r.path.endsWith('check_pat')),
        ).toHaveLength(1);
      },
      TIMEOUT,
    );
  }

  it(
    'waits for the token only after consent, then completes the same run',
    async () => {
      const server = await start((s) =>
        s.withPatResponses(AZURE.key, [MISSING, MISSING, { status: 204 }]),
      );
      const session = harness.runInteractive('init --bind', { extraEnv: ENV });
      await session.accept('Connect your DevOps platform personal access token');
      await session.decline('Set up your coding agents');
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(0);
      expect(creations(server)).toHaveLength(1);
    },
    TIMEOUT,
  );
  it(
    'uses init in the token wait timeout hint',
    async () => {
      const server = await start((s) => s.withPatResponse(AZURE.key, MISSING));
      const session = harness.runInteractive('init --bind', {
        extraEnv: { ...ENV, [ENV_IMPORT_PAT_WAIT_TIMEOUT_MS]: '100' },
      });
      await session.accept('Connect your DevOps platform personal access token');
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Timed out waiting');
      expect(result.stderr).toContain("run 'sonar init' again");
      expect(result.stderr).not.toContain('sonar import');
      expectNoCreation(server);
    },
    TIMEOUT,
  );
});
