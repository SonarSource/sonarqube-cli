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

// Integration tests for the CliInitExecuted and CliProjectInitCreationAttempted events of `sonar init`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { generateProjectProposal } from '@/commands/init/key-proposal.ts';

import {
  readCommandEvents,
  readInitExecutedEvents,
  readProjectInitEvents,
} from '../../../_common/telemetry-helpers.ts';
import type { FakeSonarQubeServerBuilder } from '../../harness';
import { TestHarness } from '../../harness';
import { git, initGitRepo } from '../hook/git-test-helpers.ts';

const TOKEN = 'init-token';
const ORG = 'my-org';
const GITHUB_REMOTE = 'https://github.com/example/repository.git';
const TIMEOUT = { timeout: 30000 };
const INTEGRATE_PROMPT = 'Set up your coding agents';

describe('sonar init telemetry', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withTelemetryEnabled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function newCloudServer() {
    return harness.newFakeServer().asSonarCloud().withAuthToken(TOKEN);
  }

  async function signInToCloud(configure: (server: FakeSonarQubeServerBuilder) => void = () => {}) {
    const builder = newCloudServer();
    configure(builder);
    const server = await builder.start();
    harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
    return server;
  }

  function withRemote(url: string) {
    initGitRepo(harness.cwd.path);
    git(['remote', 'add', 'origin', url], harness.cwd.path);
  }

  function interactive() {
    harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: 'true' });
  }

  function runEvent() {
    const events = readInitExecutedEvents(harness.sonarUserHome.path);
    expect(events).toHaveLength(1);
    return events[0].event_payload;
  }

  function projectEvents(): unknown[] {
    return readProjectInitEvents(harness.sonarUserHome.path).map((event) => event.event_payload);
  }

  it(
    'reports an already set up directory, sharing the invocation id of the command event',
    async () => {
      const server = await signInToCloud((s) => s.withProject('mapped'));
      initGitRepo(harness.cwd.path);
      harness.cwd.writeFile(
        '.sonar-config.json',
        JSON.stringify({
          project: {
            projectKey: 'mapped',
            serverUrl: server.recordedAuthServerUrl(),
            organization: ORG,
            path: '.',
          },
        }),
      );

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      const run = runEvent();
      expect(run).toMatchObject({
        steps: ['login:already_done', 'detect:already_done', 'integrate:skipped'],
        project_count: 1,
        is_interactive: false,
        is_monorepo: false,
      });
      expect(run.stopped_at ?? null).toBeNull();
      expect(run.failure_reason ?? null).toBeNull();
      expect(run.repo_id).toHaveLength(64);
      expect(projectEvents()).toEqual([
        expect.objectContaining({
          init_path: 'already_done',
          steps: ['link:already_done'],
          project_index: 0,
          project_uuid: 'AYmappedlegacy',
        }),
      ]);
      const [command] = readCommandEvents(harness.sonarUserHome.path);
      expect(command.event_payload.invocation_id).toBe(run.invocation_id);
      expect(command.event_payload.duration_ms).toBeGreaterThan(0);
      expect(command.event_payload.user_wait_ms).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'reports linking the project bound to the remote, with the time spent on prompts',
    async () => {
      interactive();
      await signInToCloud((s) =>
        s.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project').withProject('bound_project'),
      );
      withRemote(GITHUB_REMOTE);

      const session = harness.runInteractive('init');
      await session.accept('Link this directory');
      await session.waitText('Choose the folder to link');
      session.keyEnter();
      await session.decline(INTEGRATE_PROMPT);
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      const run = runEvent();
      expect(run).toMatchObject({
        steps: ['login:already_done', 'detect:success', 'integrate:declined'],
        is_interactive: true,
        remote_host: 'github',
      });
      expect(projectEvents()).toEqual([
        expect.objectContaining({
          init_path: 'link_existing',
          steps: ['link:success'],
          project_uuid: 'AYbound_projectlegacy',
        }),
      ]);
      const [command] = readCommandEvents(harness.sonarUserHome.path);
      expect(command.event_payload.user_wait_ms).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    'reports creating a project bound to the repository',
    async () => {
      interactive();
      await signInToCloud((s) =>
        s
          .withOrganizations([
            { key: ORG, name: ORG, alm: { key: 'github' }, actions: { admin: true } },
          ])
          .withDopRepositories(ORG, [
            { id: 'repo-1', name: 'repository', slug: 'example/repository' },
          ]),
      );
      withRemote(GITHUB_REMOTE);

      const session = harness.runInteractive('init');
      await session.accept('Bind this repository');
      await session.decline(INTEGRATE_PROMPT);
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(runEvent().steps).toEqual([
        'login:already_done',
        'detect:success',
        'org_bind:already_done',
        'integrate:declined',
      ]);
      expect(projectEvents()).toEqual([
        expect.objectContaining({
          init_path: 'bound_new',
          steps: ['project_bind:success', 'create_project:success'],
        }),
      ]);
    },
    TIMEOUT,
  );

  it(
    'reports declining to bind as a cancellation at the binding, since nothing else is created',
    async () => {
      interactive();
      await signInToCloud();
      withRemote(GITHUB_REMOTE);

      const session = harness.runInteractive('init');
      await session.decline('Bind this repository');
      await session.decline(INTEGRATE_PROMPT);
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(runEvent()).toMatchObject({
        stopped_at: 'project_bind',
        failure_reason: 'cancelled',
      });
      expect(projectEvents()).toEqual([
        expect.objectContaining({
          init_path: 'no_project',
          steps: ['project_bind:declined', 'link:skipped'],
          stopped_at: 'project_bind',
          failure_reason: 'cancelled',
        }),
      ]);
    },
    TIMEOUT,
  );

  it(
    'reports declining the project found under the generated key as a cancelled link',
    async () => {
      interactive();
      initGitRepo(harness.cwd.path);
      const { projectKey } = generateProjectProposal(harness.cwd.path, undefined, ORG);
      await signInToCloud((s) => s.withProject(projectKey));

      const session = harness.runInteractive('init');
      await session.decline('Link this directory to it?');
      await session.decline('another existing project');
      await session.decline(INTEGRATE_PROMPT);
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(runEvent()).toMatchObject({ stopped_at: 'link', failure_reason: 'cancelled' });
      expect(projectEvents()).toEqual([
        expect.objectContaining({
          init_path: 'link_existing',
          steps: ['project_bind:skipped', 'link:declined'],
          stopped_at: 'link',
          failure_reason: 'cancelled',
        }),
      ]);
    },
    TIMEOUT,
  );

  it(
    'reports a sign-in failure without any project event',
    async () => {
      const result = await harness.run('init --non-interactive');

      expect(result.exitCode).toBe(1);
      expect(runEvent()).toMatchObject({
        steps: ['login:failed'],
        stopped_at: 'login',
        failure_reason: 'auth',
        project_count: 0,
      });
      expect(projectEvents()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'reports a declined organization creation as no_org, before any project is known',
    async () => {
      interactive();
      const server = await newCloudServer().withOrganizations([]).start();
      harness.cwd.writeFile(
        'sonar-project.properties',
        `sonar.host.url=${server.recordedAuthServerUrl()}\n`,
      );

      const session = harness.runInteractive('init', { browserToken: TOKEN });
      await session.decline('Create an organization now?');
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(runEvent()).toMatchObject({
        steps: ['login:success', 'create_org:declined', 'integrate:skipped'],
        stopped_at: 'create_org',
        failure_reason: 'no_org',
        project_count: 0,
      });
      expect(projectEvents()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'reports a repository of another organization as other_org',
    async () => {
      await signInToCloud((s) => s.withGitRemoteBoundInOtherOrg(GITHUB_REMOTE));
      withRemote(GITHUB_REMOTE);

      const result = await harness.run('init --non-interactive');

      expect(result.exitCode).toBe(1);
      expect(runEvent()).toMatchObject({
        steps: ['login:already_done', 'detect:failed'],
        stopped_at: 'detect',
        failure_reason: 'other_org',
      });
      expect(projectEvents()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'reports Ctrl+C at the integrate offer as a cancellation of the run',
    async () => {
      interactive();
      await signInToCloud((s) =>
        s.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project').withProject('bound_project'),
      );
      withRemote(GITHUB_REMOTE);

      const session = harness.runInteractive('init');
      await session.accept('Link this directory');
      await session.waitText('Choose the folder to link');
      session.keyEnter();
      await session.waitText(INTEGRATE_PROMPT);
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(1);
      expect(runEvent()).toMatchObject({
        steps: ['login:already_done', 'detect:success', 'integrate:failed'],
        stopped_at: 'integrate',
        failure_reason: 'cancelled',
      });
      expect(projectEvents()).toEqual([
        expect.objectContaining({ steps: ['link:success'], failure_reason: null }),
      ]);
    },
    TIMEOUT,
  );

  it(
    'reports each monorepo root, and one without a project as failed without stopping the run',
    async () => {
      await signInToCloud((s) => s.withProject('api-key'));
      initGitRepo(harness.cwd.path);
      harness.cwd.writeFile('api/.keep', '');
      harness.cwd.writeFile('web/.keep', '');

      await harness.run('init --monorepo --non-interactive --root api=api-key --root web=web-key');

      const run = runEvent();
      expect(run).toMatchObject({ is_monorepo: true, project_count: 2, failure_reason: null });
      expect(run.stopped_at ?? null).toBeNull();
      expect(projectEvents()).toEqual([
        expect.objectContaining({
          project_index: 0,
          init_path: 'link_existing',
          steps: ['link:success'],
          project_uuid: 'AYapi-keylegacy',
        }),
        expect.objectContaining({
          project_index: 1,
          init_path: 'no_project',
          steps: ['project_bind:skipped', 'link:failed'],
          stopped_at: 'link',
          failure_reason: 'no_project_available',
        }),
      ]);
    },
    TIMEOUT,
  );

  it(
    'ends a --bind attempt whose authorization is declined at its project creation',
    async () => {
      interactive();
      await signInToCloud((s) =>
        s.withOrganizations([{ key: ORG, name: ORG, actions: { admin: true } }]),
      );
      withRemote(GITHUB_REMOTE);

      const session = harness.runInteractive('init --bind');
      await session.decline('Authorize it in the browser');
      await session.decline(INTEGRATE_PROMPT);
      await session.waitFinish();

      expect(runEvent()).toMatchObject({
        stopped_at: 'create_project',
        failure_reason: 'cancelled',
      });
      expect(projectEvents()).toEqual([
        expect.objectContaining({
          init_path: 'bound_new',
          steps: ['project_bind:success', 'create_project:declined'],
          stopped_at: 'create_project',
          failure_reason: 'cancelled',
        }),
      ]);
    },
    TIMEOUT,
  );

  for (const interactiveRun of [true, false]) {
    it.each(['no remote', 'unsupported remote', 'SonarQube Server'])(
      `reports no_project_available with %s (interactive=${interactiveRun})`,
      async (situation) => {
        const server =
          situation === 'SonarQube Server'
            ? await harness.newFakeServer().withAuthToken(TOKEN).start()
            : await signInToCloud();
        if (situation === 'SonarQube Server') {
          harness.withAuth(server.recordedAuthServerUrl(), TOKEN);
        }
        if (situation === 'no remote') {
          initGitRepo(harness.cwd.path);
        } else {
          withRemote(
            situation === 'unsupported remote'
              ? 'https://gitlab.com/example/repository.git'
              : GITHUB_REMOTE,
          );
        }
        let result;
        if (interactiveRun) {
          interactive();
          const session = harness.runInteractive('init');
          await session.decline(INTEGRATE_PROMPT);
          result = await session.waitFinish();
        } else {
          result = await harness.run('init --non-interactive');
        }
        expect(result.exitCode).toBe(interactiveRun ? 0 : 2);
        expect(runEvent()).toMatchObject({
          stopped_at: 'link',
          failure_reason: 'no_project_available',
        });
        expect(projectEvents()).toEqual([
          expect.objectContaining({
            init_path: 'no_project',
            steps: ['project_bind:skipped', `link:${interactiveRun ? 'skipped' : 'failed'}`],
            stopped_at: 'link',
            failure_reason: 'no_project_available',
            project_uuid: null,
          }),
        ]);
        expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
        expect(
          server
            .getRecordedRequests()
            .some(
              (request) =>
                request.method === 'POST' && request.path.startsWith('/api/alm_integration/'),
            ),
        ).toBe(false);
      },
      TIMEOUT,
    );
  }

  it(
    'classifies a bare --link with no matching project as no_project_available',
    async () => {
      await signInToCloud();
      initGitRepo(harness.cwd.path);
      const result = await harness.run('init --non-interactive --link');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--link found no SonarQube project');
      expect(runEvent()).toMatchObject({
        stopped_at: 'link',
        failure_reason: 'no_project_available',
      });
      expect(projectEvents()).toEqual([
        expect.objectContaining({
          init_path: 'no_project',
          failure_reason: 'no_project_available',
        }),
      ]);
    },
    TIMEOUT,
  );

  it(
    'changes no_project to link_existing when a generated-key project is linked',
    async () => {
      initGitRepo(harness.cwd.path);
      const { projectKey } = generateProjectProposal(harness.cwd.path, undefined, ORG);
      await signInToCloud((s) => s.withProject(projectKey));
      const result = await harness.run('init --non-interactive');
      expect(result.exitCode).toBe(0);
      expect(runEvent()).toMatchObject({ stopped_at: null, failure_reason: null });
      expect(projectEvents()).toEqual([
        expect.objectContaining({
          init_path: 'link_existing',
          steps: ['project_bind:skipped', 'link:success'],
          stopped_at: null,
          failure_reason: null,
        }),
      ]);
    },
    TIMEOUT,
  );

  it.each([
    [403, 'permission'],
    [500, 'network'],
  ] as const)(
    'preserves %s lookup failures instead of claiming no project is available',
    async (status, reason) => {
      initGitRepo(harness.cwd.path);
      const { projectKey } = generateProjectProposal(harness.cwd.path, undefined, undefined);
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(projectKey, (project) => project.withComponentShowError(status))
        .start();
      harness.withAuth(server.recordedAuthServerUrl(), TOKEN);
      const result = await harness.run('init --non-interactive');
      expect(result.exitCode).not.toBe(0);
      expect(runEvent()).toMatchObject({ stopped_at: 'link', failure_reason: reason });
      expect(projectEvents()).toEqual([
        expect.objectContaining({
          init_path: 'no_project',
          failure_reason: reason,
        }),
      ]);
    },
    TIMEOUT,
  );

  it(
    'keeps a declined authorization as cancelled when it falls back to no project',
    async () => {
      interactive();
      await signInToCloud((s) =>
        s.withOrganizations([{ key: ORG, name: ORG, actions: { admin: true } }]),
      );
      withRemote(GITHUB_REMOTE);
      const session = harness.runInteractive('init');
      await session.accept('Bind this repository');
      await session.decline('Authorize it in the browser');
      await session.decline(INTEGRATE_PROMPT);
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(0);
      expect(runEvent()).toMatchObject({ stopped_at: 'org_bind', failure_reason: 'cancelled' });
      expect(projectEvents()).toEqual([
        expect.objectContaining({
          init_path: 'no_project',
          failure_reason: null,
        }),
      ]);
    },
    TIMEOUT,
  );

  it.each(['declining binding', 'link-only selection'])(
    'classifies monorepo roots left without a project after %s',
    async (choice) => {
      await signInToCloud();
      withRemote(GITHUB_REMOTE);
      harness.cwd.writeFile('web/.keep', '');
      if (choice === 'declining binding') {
        interactive();
        const session = harness.runInteractive('init --monorepo --root web=web-key');
        await session.decline('Bind the 1 new project');
        await session.decline(INTEGRATE_PROMPT);
        await session.waitFinish();
      } else {
        await harness.run('init --monorepo --non-interactive --link --root web=web-key');
      }
      expect(runEvent()).toMatchObject({ stopped_at: null, failure_reason: null });
      expect(projectEvents()).toEqual([
        expect.objectContaining({
          init_path: 'no_project',
          stopped_at: 'link',
          failure_reason: choice === 'declining binding' ? 'cancelled' : 'no_project_available',
        }),
      ]);
    },
    TIMEOUT,
  );

  it(
    'emits no init event for a dry run',
    async () => {
      await signInToCloud((s) => s.withProject('my-key'));
      initGitRepo(harness.cwd.path);

      const result = await harness.run('init --dry-run --non-interactive --link my-key');

      expect(result.exitCode).toBe(0);
      expect(readInitExecutedEvents(harness.sonarUserHome.path)).toEqual([]);
      expect(projectEvents()).toEqual([]);
      expect(readCommandEvents(harness.sonarUserHome.path)).toHaveLength(1);
    },
    TIMEOUT,
  );
});
