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

import { ENV_ORG, ENV_SERVER, ENV_TOKEN } from '@/core/auth/auth-resolver.ts';

import {
  readInitExecutedEvents,
  readProjectInitEvents,
} from '../../../_common/telemetry-helpers.ts';
import { TestHarness } from '../../harness';
import { git, initGitRepo } from '../hook/git-test-helpers.ts';

const TOKEN = 'valid-init-token';
const INVALID_TOKEN = 'revoked-init-token-do-not-print';
const ORG = 'my-org';
const TIMEOUT = { timeout: 30000 };

describe('init authentication preflight', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: '1' });
    harness.state().withTelemetryEnabled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  for (const source of ['saved', 'environment']) {
    it.each(['init --non-interactive', 'init --monorepo'])(
      `rejects invalid ${source} Cloud credentials before %s proceeds`,
      async (command) => {
        const server = await harness.newFakeServer().asSonarCloud().withAuthToken(TOKEN).start();
        if (source === 'saved') {
          harness.withAuth(server.recordedAuthServerUrl(), INVALID_TOKEN, ORG);
        } else {
          harness.withExtraEnv({
            [ENV_TOKEN]: INVALID_TOKEN,
            [ENV_SERVER]: server.recordedAuthServerUrl(),
            [ENV_ORG]: ORG,
          });
        }
        const result = await harness.run(command);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('The active SonarQube token is invalid or expired.');
        expect(result.stderr).toContain(source === 'saved' ? 'sonar auth login' : ENV_TOKEN);
        expect(result.stdout + result.stderr).not.toContain(INVALID_TOKEN);
        for (const prompt of [
          'Bind this repository',
          'Choose the project folders',
          'Set up your coding agents',
        ]) {
          expect(result.stdout).not.toContain(prompt);
        }
        expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
        const requests = server.getRecordedRequests();
        expect(requests.filter((r) => r.path === '/api/authentication/validate')).toHaveLength(1);
        expect(requests.some((r) => r.path === '/api/components/show')).toBe(false);
        expect(requests.some((r) => r.method === 'POST')).toBe(false);
        const events = readInitExecutedEvents(harness.sonarUserHome.path);
        expect(events).toHaveLength(1);
        expect(events[0].event_payload).toMatchObject({
          steps: ['login:failed'],
          stopped_at: 'login',
          failure_reason: 'auth',
          project_count: 0,
        });
        expect(readProjectInitEvents(harness.sonarUserHome.path)).toEqual([]);
      },
      TIMEOUT,
    );
  }

  it(
    'validates Cloud credentials for a dry run',
    async () => {
      const server = await harness.newFakeServer().asSonarCloud().withAuthToken(TOKEN).start();
      harness.withAuth(server.recordedAuthServerUrl(), INVALID_TOKEN, ORG);
      const result = await harness.run('init --dry-run --non-interactive');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid or expired');
      expect(readInitExecutedEvents(harness.sonarUserHome.path)).toEqual([]);
      expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'links an accessible Cloud project without administrator permission',
    async () => {
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken(TOKEN)
        .withProvisionProjectsPermission(false)
        .withProject('existing-project')
        .withOrganizations([{ key: ORG, name: ORG, actions: { admin: false } }])
        .start();
      harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
      const result = await harness.run('init --link existing-project --non-interactive');
      expect(result.exitCode).toBe(0);
      expect(harness.cwd.file('.sonar-config.json').asText()).toContain('existing-project');
      const requests = server.getRecordedRequests();
      const validateAt = requests.findIndex((r) => r.path === '/api/authentication/validate');
      expect(validateAt).toBeGreaterThanOrEqual(0);
      expect(requests.findIndex((r) => r.path === '/api/components/show')).toBeGreaterThan(
        validateAt,
      );
      expect(requests.some((r) => r.method === 'POST')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'reports an unreachable server as a connection failure rather than invalid credentials',
    async () => {
      const server = await harness.newFakeServer().asSonarCloud().withAuthToken(TOKEN).start();
      harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
      await server.stop();
      const result = await harness.run('init --non-interactive');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Could not validate the active SonarQube connection.');
      expect(result.stderr).toContain('Check your network connection');
      expect(result.stderr).not.toContain('invalid or expired');
      const events = readInitExecutedEvents(harness.sonarUserHome.path);
      expect(events).toHaveLength(1);
      expect(events[0].event_payload).toMatchObject({
        stopped_at: 'login',
        failure_reason: 'network',
        project_count: 0,
      });
    },
    TIMEOUT,
  );
  it.each([
    'init',
    'init --bind --non-interactive',
    'init --bind --dry-run --non-interactive',
    'init --monorepo --root web=web-key',
    'init --monorepo --bind --non-interactive --root web=web-key',
    'init --monorepo --bind --dry-run --non-interactive --root web=web-key',
  ])(
    'checks Cloud import permissions before any bind prompt: %s',
    async (command) => {
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken(TOKEN)
        .withOrganizations([{ key: ORG, name: ORG, actions: { admin: false } }])
        .start();
      harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
      initGitRepo(harness.cwd.path);
      git(
        ['remote', 'add', 'origin', 'https://github.com/example/repository.git'],
        harness.cwd.path,
      );
      harness.cwd.writeFile('web/.keep', '');
      const result = await harness.run(command);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`You must be an administrator of organization '${ORG}'`);
      expect(result.stderr).toContain('Ask an administrator');
      for (const prompt of [
        'Bind this repository',
        'Bind the 1 new project',
        'Authorize it in the browser',
        'Set up your coding agents',
      ]) {
        expect(result.stdout).not.toContain(prompt);
      }
      expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
      expect(server.getRecordedRequests().some((r) => r.method === 'POST')).toBe(false);
      const events = readInitExecutedEvents(harness.sonarUserHome.path);
      const roots = readProjectInitEvents(harness.sonarUserHome.path);
      if (command.includes('--dry-run')) {
        expect(events).toEqual([]);
        expect(roots).toEqual([]);
      } else {
        expect(events).toHaveLength(1);
        expect(events[0].event_payload).toMatchObject({ failure_reason: 'permission' });
        expect(roots).toHaveLength(1);
        expect(roots[0].event_payload).toMatchObject({
          steps: ['project_bind:failed'],
          stopped_at: 'project_bind',
          failure_reason: 'permission',
        });
      }
    },
    TIMEOUT,
  );

  it(
    'checks admin access before offering binding when access is granted',
    async () => {
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken(TOKEN)
        .withOrganizations([{ key: ORG, name: ORG, actions: { admin: true } }])
        .start();
      harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
      initGitRepo(harness.cwd.path);
      git(
        ['remote', 'add', 'origin', 'https://github.com/example/repository.git'],
        harness.cwd.path,
      );
      const session = harness.runInteractive('init');
      await session.waitText('Bind this repository');
      expect(server.getRecordedRequests().some((r) => r.path === '/api/organizations/search')).toBe(
        true,
      );
      session.write('n');
      await session.decline('Set up your coding agents');
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'does not require Cloud admin access when linking the detected existing project',
    async () => {
      const remote = 'https://github.com/example/repository.git';
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken(TOKEN)
        .withOrganizations([{ key: ORG, name: ORG, actions: { admin: false } }])
        .withProject('existing-project')
        .withGitRemoteBinding(remote, 'existing-project')
        .start();
      harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
      initGitRepo(harness.cwd.path);
      git(['remote', 'add', 'origin', remote], harness.cwd.path);
      const session = harness.runInteractive('init --path .');
      await session.accept('Link this directory to it?');
      await session.decline('Set up your coding agents');
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(0);
      expect(harness.cwd.file('.sonar-config.json').asText()).toContain('existing-project');
      expect(server.getRecordedRequests().some((r) => r.method === 'POST')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'fails closed if the Cloud permission lookup is unavailable',
    async () => {
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken(TOKEN)
        .withOrganizationsSearchError(500)
        .start();
      harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
      initGitRepo(harness.cwd.path);
      git(
        ['remote', 'add', 'origin', 'https://github.com/example/repository.git'],
        harness.cwd.path,
      );
      const result = await harness.run('init');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Failed to look up organization');
      expect(result.stdout).not.toContain('Bind this repository');
      expect(server.getRecordedRequests().some((r) => r.method === 'POST')).toBe(false);
      const events = readInitExecutedEvents(harness.sonarUserHome.path);
      expect(events[0].event_payload).toMatchObject({ failure_reason: 'network' });
    },
    TIMEOUT,
  );
  for (const source of ['saved', 'environment']) {
    it.each(['init --non-interactive', 'init --monorepo'])(
      `rejects invalid ${source} Server credentials before %s proceeds`,
      async (command) => {
        const server = await harness.newFakeServer().withAuthToken(TOKEN).start();
        if (source === 'saved') harness.withAuth(server.recordedAuthServerUrl(), INVALID_TOKEN);
        else
          harness.withExtraEnv({
            [ENV_TOKEN]: INVALID_TOKEN,
            [ENV_SERVER]: server.recordedAuthServerUrl(),
          });
        const result = await harness.run(command);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('The active SonarQube token is invalid or expired.');
        expect(result.stdout + result.stderr).not.toContain(INVALID_TOKEN);
        expect(result.stdout).not.toContain('Choose the project folders');
        const requests = server.getRecordedRequests();
        expect(requests.filter((r) => r.path === '/api/authentication/validate')).toHaveLength(1);
        expect(requests.some((r) => r.path === '/api/components/show')).toBe(false);
        expect(requests.some((r) => r.method === 'POST')).toBe(false);
        const events = readInitExecutedEvents(harness.sonarUserHome.path);
        expect(events).toHaveLength(1);
        expect(events[0].event_payload).toMatchObject({
          steps: ['login:failed'],
          stopped_at: 'login',
          failure_reason: 'auth',
          project_count: 0,
        });
        expect(readProjectInitEvents(harness.sonarUserHome.path)).toEqual([]);
      },
      TIMEOUT,
    );
  }

  it(
    'validates Server credentials for a dry run',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(TOKEN).start();
      harness.withAuth(server.recordedAuthServerUrl(), INVALID_TOKEN);
      const result = await harness.run('init --dry-run --non-interactive');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid or expired');
      expect(readInitExecutedEvents(harness.sonarUserHome.path)).toEqual([]);
    },
    TIMEOUT,
  );

  it.each(['init --link existing-project --non-interactive', 'link existing-project'])(
    'preserves linking existing Server projects: %s',
    async (command) => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProvisionProjectsPermission(false)
        .withProject('existing-project')
        .start();
      harness.withAuth(server.recordedAuthServerUrl(), TOKEN);
      const result = await harness.run(command);
      expect(result.exitCode).toBe(0);
      expect(harness.cwd.file('.sonar-config.json').asText()).toContain('existing-project');
      expect(server.getRecordedRequests().some((r) => r.method === 'POST')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'preserves already-configured Server projects',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject('existing-project')
        .start();
      harness.withAuth(server.recordedAuthServerUrl(), TOKEN);
      const config = JSON.stringify({
        project: {
          projectKey: 'existing-project',
          serverUrl: server.recordedAuthServerUrl(),
          path: '.',
        },
      });
      harness.cwd.writeFile('.sonar-config.json', config);
      const result = await harness.run('init --non-interactive');
      expect(result.exitCode).toBe(0);
      expect(harness.cwd.file('.sonar-config.json').asText()).toBe(config);
    },
    TIMEOUT,
  );
});
