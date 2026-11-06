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

// Integration tests for `sonar init`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { generateProjectProposal } from '@/commands/init/key-proposal.ts';
import { ALPHA_ENV_VAR } from '@/core/commands/stage.ts';

import type { FakeSonarQubeServer, FakeSonarQubeServerBuilder } from '../../harness';
import { TestHarness } from '../../harness';
import { git, initGitRepo } from '../hook/git-test-helpers.ts';

const TOKEN = 'init-token';
const ORG = 'my-org';
const GITHUB_REMOTE = 'https://github.com/example/repository.git';
const AZURE_REMOTE = 'https://dev.azure.com/example/project/_git/repository';
const GITLAB_REMOTE = 'https://gitlab.com/example/repository.git';
const TIMEOUT = { timeout: 30000 };
const INTEGRATE_PROMPT = 'Set up your coding agents';

describe('sonar init', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.withExtraEnv({ [ALPHA_ENV_VAR]: 'true' });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function signInToCloud(configure: (server: ReturnType<typeof newCloudServer>) => void) {
    const builder = newCloudServer();
    configure(builder);
    const server = await builder.start();
    harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
    return server.recordedAuthServerUrl();
  }

  function writeSonarConfig(serverUrl: string, path = '.') {
    harness.cwd.writeFile(
      '.sonar-config.json',
      JSON.stringify({ project: { projectKey: 'mapped', serverUrl, organization: ORG, path } }),
    );
  }

  function newCloudServer() {
    return harness.newFakeServer().asSonarCloud().withAuthToken(TOKEN);
  }

  function withRemote(url: string) {
    initGitRepo(harness.cwd.path);
    git(['remote', 'add', 'origin', url], harness.cwd.path);
  }

  const UNBOUND = 'Created project';

  async function createProject(session: ReturnType<typeof harness.runInteractive>) {
    await session.waitText('Project name');
    session.keyEnter();
    await session.waitText('Project visibility');
    session.keyEnter();
    await session.accept('Create this project');
  }

  it(
    'fails with a hint when not signed in and non-interactive',
    async () => {
      const result = await harness.run('init --non-interactive');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Not signed in.');
      expect(result.stdout + result.stderr).toContain("Run 'sonar auth login'");
    },
    TIMEOUT,
  );

  it(
    'rejects a --path that is not a directory',
    async () => {
      await signInToCloud(() => {});

      const result = await harness.run('init --path does-not-exist');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('is not an existing directory');
    },
    TIMEOUT,
  );

  it(
    'reports setup as complete when .sonar-config.json already maps a project',
    async () => {
      const serverUrl = await signInToCloud(() => {});
      initGitRepo(harness.cwd.path);
      writeSonarConfig(serverUrl);

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("linked to the Sonar project 'mapped'");
      expect(result.stdout).toContain("'sonar integrate'");
    },
    TIMEOUT,
  );

  it(
    'does not report setup as complete when .sonar-config.json maps another connection',
    async () => {
      await signInToCloud(() => {});
      initGitRepo(harness.cwd.path);
      writeSonarConfig('https://sq.example.com');

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(UNBOUND);
    },
    TIMEOUT,
  );

  it(
    'does not report setup as complete when .sonar-config.json maps an unrelated directory',
    async () => {
      const serverUrl = await signInToCloud(() => {});
      initGitRepo(harness.cwd.path);
      harness.cwd.writeFile('backend/.keep', '');
      harness.cwd.writeFile('frontend/.keep', '');
      writeSonarConfig(serverUrl, 'backend');

      const result = await harness.run('init --path frontend');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(UNBOUND);
    },
    TIMEOUT,
  );

  it(
    'does not report setup as complete when .sonar-config.json maps only a project below the root',
    async () => {
      const serverUrl = await signInToCloud(() => {});
      initGitRepo(harness.cwd.path);
      harness.cwd.writeFile('backend/.keep', '');
      writeSonarConfig(serverUrl, 'backend');

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(UNBOUND);
      expect(result.stdout).not.toContain('Nothing left to set up');
    },
    TIMEOUT,
  );

  it(
    'reports setup as complete when .sonar-config.json sits in a directory between --path and the repository root',
    async () => {
      const serverUrl = await signInToCloud(() => {});
      initGitRepo(harness.cwd.path);
      harness.cwd.writeFile('services/api/.keep', '');
      harness.cwd.writeFile(
        'services/.sonar-config.json',
        JSON.stringify({
          project: { projectKey: 'mapped', serverUrl, organization: ORG, path: '.' },
        }),
      );

      const result = await harness.run('init --path services/api');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("linked to the Sonar project 'mapped'");
    },
    TIMEOUT,
  );

  it(
    'does not report setup as complete from sonar-project.properties alone',
    async () => {
      await signInToCloud(() => {});
      initGitRepo(harness.cwd.path);
      harness.cwd.writeFile(
        'sonar-project.properties',
        `sonar.projectKey=local-key\nsonar.organization=${ORG}\n`,
      );

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(UNBOUND);
      expect(result.stdout).not.toContain('Nothing left to set up');
    },
    TIMEOUT,
  );

  it(
    'continues with a note when the binding lookup cannot tell',
    async () => {
      await signInToCloud((server) => server.withProjectBindingsStatus(500));
      withRemote(GITHUB_REMOTE);

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Could not check whether this repository is already bound');
      expect(result.stdout).toContain(UNBOUND);
    },
    TIMEOUT,
  );

  it(
    'resolves the repository remote from a subdirectory given with --path',
    async () => {
      await signInToCloud((server) => server.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project'));
      withRemote(GITHUB_REMOTE);
      harness.cwd.writeFile('packages/app/.keep', '');

      const result = await harness.run('init --path packages/app');

      // Linking needs an answer, so the non-interactive run stops at the hint for that path.
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'sonar link bound_project --path packages/app',
      );
    },
    TIMEOUT,
  );

  it(
    'finds the bound project for a remote that embeds credentials, without printing them',
    async () => {
      await signInToCloud((server) => server.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project'));
      withRemote('https://user:secret-token@github.com/example/repository.git');

      const result = await harness.run('init');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('bound_project');
      expect(result.stdout + result.stderr).not.toContain('secret-token');
    },
    TIMEOUT,
  );

  it(
    'does not select link-existing from a project key in local scanner config alone',
    async () => {
      await signInToCloud(() => {});
      withRemote(GITLAB_REMOTE);
      harness.cwd.writeFile(
        'sonar-project.properties',
        `sonar.projectKey=local_only\nsonar.organization=${ORG}\n`,
      );

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(UNBOUND);
    },
    TIMEOUT,
  );

  it(
    'fails with a sonar link hint instead of creating a second project when it cannot ask',
    async () => {
      await signInToCloud((server) => server.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project'));
      withRemote(GITHUB_REMOTE);

      const result = await harness.run('init');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain(
        "A Sonar project already exists for this repository: 'bound_project'",
      );
      expect(output).toContain('sonar link bound_project');
      expect(output).not.toContain(UNBOUND);
      expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'selects the unbound path without a prompt when there is no git remote',
    async () => {
      await signInToCloud(() => {});

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(UNBOUND);
    },
    TIMEOUT,
  );

  it(
    'selects the unbound path without a prompt when the remote is on another host',
    async () => {
      await signInToCloud(() => {});
      withRemote(GITLAB_REMOTE);

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(UNBOUND);
    },
    TIMEOUT,
  );

  it(
    'selects the unbound path and says why when binding needs an answer that cannot be asked',
    async () => {
      await signInToCloud(() => {});
      withRemote(GITHUB_REMOTE);

      const result = await harness.run('init --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(UNBOUND);
      expect(result.stderr).toContain('Not binding the repository');
    },
    TIMEOUT,
  );

  it(
    'fails and suggests sonar auth org when the repository belongs to another organization',
    async () => {
      await signInToCloud((server) => server.withGitRemoteBoundInOtherOrg(GITHUB_REMOTE));
      withRemote(GITHUB_REMOTE);

      const result = await harness.run('init');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(`another organization than ${ORG}`);
      expect(result.stdout + result.stderr).toContain("'sonar auth org'");
      expect(result.stdout).not.toContain('Selected path');
    },
    TIMEOUT,
  );

  it(
    'names the bound organization when .sonar-config.json records another one',
    async () => {
      const serverUrl = await signInToCloud((server) =>
        server.withGitRemoteBoundInOtherOrg(GITHUB_REMOTE),
      );
      withRemote(GITHUB_REMOTE);
      harness.cwd.writeFile(
        '.sonar-config.json',
        JSON.stringify({
          project: { projectKey: 'mapped', serverUrl, organization: 'their-org', path: '.' },
        }),
      );

      const result = await harness.run('init');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        `organization 'their-org', but you are connected to '${ORG}'`,
      );
      expect(result.stdout + result.stderr).toContain("'sonar auth org their-org'");
    },
    TIMEOUT,
  );

  it(
    'does not echo a recorded organization that is not a plain key into the sonar auth org hint',
    async () => {
      const serverUrl = await signInToCloud((server) =>
        server.withGitRemoteBoundInOtherOrg(GITHUB_REMOTE),
      );
      withRemote(GITHUB_REMOTE);
      harness.cwd.writeFile(
        '.sonar-config.json',
        JSON.stringify({
          project: {
            projectKey: 'mapped',
            serverUrl,
            organization: 'x; sh ./payload.sh #',
            path: '.',
          },
        }),
      );

      const result = await harness.run('init');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(`another organization than ${ORG}`);
      expect(result.stdout + result.stderr).toContain("'sonar auth org'");
      expect(result.stdout + result.stderr).not.toContain('payload.sh');
    },
    TIMEOUT,
  );

  describe('organization creation for an account without organizations', () => {
    const CREATE_PROMPT = 'Create an organization now?';
    const NEW_ORG = 'brand-new-org';

    async function startOrglessServer(
      configure: (server: FakeSonarQubeServerBuilder) => void = () => {},
    ) {
      harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: 'true' });
      const builder = newCloudServer().withOrganizations([]);
      configure(builder);
      return builder.start();
    }

    /** Lets the login find the server without asking; `init` itself ignores local config. */
    function pointAtServer(server: FakeSonarQubeServer) {
      harness.cwd.writeFile(
        'sonar-project.properties',
        `sonar.host.url=${server.recordedAuthServerUrl()}\n`,
      );
    }

    function calls(server: FakeSonarQubeServer, method: string, path: string) {
      return server.getRecordedRequests().filter((r) => r.method === method && r.path === path);
    }

    async function nameTheOrganization(session: ReturnType<typeof harness.runInteractive>) {
      await session.waitText('Organization name');
      session.write('Brand New Org');
      session.keyEnter();
    }

    it(
      'stops and suggests sonar integrate when the user declines',
      async () => {
        const server = await startOrglessServer();
        pointAtServer(server);

        const session = harness.runInteractive('init', { browserToken: TOKEN });
        await session.decline(CREATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No organization was created.');
        expect(result.stdout).toContain('An organization holds your projects');
        expect(result.stdout).toContain(
          "A project needs an organization. Secrets scanning doesn't.",
        );
        expect(result.stdout).toContain("Next, run 'sonar integrate'");
        expect(result.stdout.indexOf('A project needs an organization.')).toBeLessThan(
          result.stdout.indexOf("Next, run 'sonar integrate'"),
        );
        expect(calls(server, 'POST', '/api/organizations/create')).toHaveLength(0);
        expect(calls(server, 'POST', '/billing/subscriptions')).toHaveLength(0);
      },
      TIMEOUT,
    );

    it(
      'creates the organization, subscribes it to Free, then continues with it active',
      async () => {
        const server = await startOrglessServer();
        pointAtServer(server);
        initGitRepo(harness.cwd.path);

        const session = harness.runInteractive('init', { browserToken: TOKEN });
        await session.accept(CREATE_PROMPT);
        await nameTheOrganization(session);
        await createProject(session);
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`Created organization 'Brand New Org' (key: ${NEW_ORG})`);
        expect(result.stdout).toContain("It's on the Free plan");
        expect(result.stdout).toContain(`/organizations/${NEW_ORG}/billing`);
        const [creation] = calls(server, 'POST', '/api/organizations/create');
        const form = new URLSearchParams(creation.body);
        expect(form.get('key')).toBe(NEW_ORG);
        expect(form.get('name')).toBe('Brand New Org');
        const [subscription] = calls(server, 'POST', '/billing/subscriptions');
        expect(JSON.parse(subscription.body ?? '{}')).toMatchObject({
          entityId: `${NEW_ORG}-uuid-v4`,
          priceId: 'price-free',
          email: 'fake-user@example.com',
        });
        expect(subscription.timestamp).toBeGreaterThanOrEqual(creation.timestamp);
        const [project] = calls(server, 'POST', '/api/projects/create');
        expect(new URLSearchParams(project.body).get('organization')).toBe(NEW_ORG);
      },
      TIMEOUT,
    );

    it(
      'waits for Cloud to expose the new organization before subscribing it',
      async () => {
        const server = await startOrglessServer((builder) =>
          builder.withCreatedOrganizationHiddenFor(2),
        );
        pointAtServer(server);
        initGitRepo(harness.cwd.path);

        const session = harness.runInteractive('init', { browserToken: TOKEN });
        await session.accept(CREATE_PROMPT);
        await nameTheOrganization(session);
        await createProject(session);
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(calls(server, 'GET', '/organizations/organizations').length).toBeGreaterThan(2);
        expect(calls(server, 'POST', '/billing/subscriptions')).toHaveLength(1);
      },
      TIMEOUT,
    );

    it(
      'retries with a random suffix when the derived key is taken',
      async () => {
        const server = await startOrglessServer((builder) =>
          builder.withVisibleOrganizations([{ key: NEW_ORG, name: 'Someone else' }]),
        );
        pointAtServer(server);
        initGitRepo(harness.cwd.path);

        const session = harness.runInteractive('init', { browserToken: TOKEN });
        await session.accept(CREATE_PROMPT);
        await nameTheOrganization(session);
        await createProject(session);
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        const [creation] = calls(server, 'POST', '/api/organizations/create');
        expect(new URLSearchParams(creation.body).get('key')).toMatch(
          new RegExp(`^${NEW_ORG}-[0-9a-f]{6}$`),
        );
      },
      TIMEOUT,
    );

    it.each([403, 404])(
      'fails and names sonar integrate when creation answers %d',
      async (status) => {
        const server = await startOrglessServer((builder) =>
          builder.withOrganizationCreateRejected(status),
        );
        pointAtServer(server);

        const session = harness.runInteractive('init', { browserToken: TOKEN });
        await session.accept(CREATE_PROMPT);
        await nameTheOrganization(session);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Organization creation is not available');
        expect(output).toContain("run 'sonar integrate'");
        expect(calls(server, 'POST', '/billing/subscriptions')).toHaveLength(0);
      },
      TIMEOUT,
    );

    it(
      'says the organization was created when the subscription step fails',
      async () => {
        const server = await startOrglessServer((builder) =>
          builder.withSubscriptionCreateRejected(500),
        );
        pointAtServer(server);

        const session = harness.runInteractive('init', { browserToken: TOKEN });
        await session.accept(CREATE_PROMPT);
        await nameTheOrganization(session);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain(`Organization '${NEW_ORG}' was created`);
        expect(output).toContain("run 'sonar init' again");
        expect(calls(server, 'POST', '/api/organizations/create')).toHaveLength(1);
      },
      TIMEOUT,
    );

    it(
      'makes no billing call for an account that already has an organization',
      async () => {
        harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: 'true' });
        const server = await newCloudServer()
          .withOrganizations([{ key: ORG, name: 'My Org' }])
          .start();
        pointAtServer(server);
        initGitRepo(harness.cwd.path);

        const session = harness.runInteractive('init', { browserToken: TOKEN });
        await createProject(session);
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(
          server.getRecordedRequests().filter((r) => r.path.startsWith('/billing/subscriptions')),
        ).toHaveLength(0);
        expect(calls(server, 'POST', '/api/organizations/create')).toHaveLength(0);
      },
      TIMEOUT,
    );
  });

  it(
    'signs in through the browser when not signed in, then detects the project',
    async () => {
      harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: 'true' });
      const server = await newCloudServer()
        .withOrganizations([{ key: ORG, name: 'My Org' }])
        .start();
      harness.cwd.writeFile(
        '.sonar-config.json',
        JSON.stringify({
          project: {
            projectKey: 'p',
            serverUrl: server.recordedAuthServerUrl(),
            organization: ORG,
            path: '.',
          },
        }),
      );

      const session = harness.runInteractive('init', { browserToken: TOKEN });
      await session.decline(INTEGRATE_PROMPT);
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("linked to the Sonar project 'p'");
    },
    TIMEOUT,
  );

  describe('sonar integrate prompt', () => {
    async function startLinkedInit() {
      harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: 'true' });
      const serverUrl = await signInToCloud(() => {});
      initGitRepo(harness.cwd.path);
      writeSonarConfig(serverUrl);
      return harness.runInteractive('init');
    }

    it(
      'succeeds without repeating the hint when the user declines',
      async () => {
        const session = await startLinkedInit();
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toContain("Next, run 'sonar integrate'");
      },
      TIMEOUT,
    );

    it(
      'runs sonar integrate when the user accepts, and still succeeds when it is abandoned',
      async () => {
        const session = await startLinkedInit();
        await session.accept(INTEGRATE_PROMPT);
        await session.waitText('Select the tool you want to integrate with');
        session.keyCtrlC();
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain('Could not set up your coding agents');
        expect(result.stdout + result.stderr).toContain("Run 'sonar integrate' to try again.");
        expect(harness.cwd.file('.sonar-config.json').asText()).toContain('"mapped"');
      },
      TIMEOUT,
    );

    it(
      'cancels onboarding on Ctrl+C at the prompt',
      async () => {
        const session = await startLinkedInit();
        await session.waitText(INTEGRATE_PROMPT);
        session.keyCtrlC();
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain('Onboarding cancelled.');
      },
      TIMEOUT,
    );

    it(
      'does not ask without a terminal',
      async () => {
        const serverUrl = await signInToCloud(() => {});
        initGitRepo(harness.cwd.path);
        writeSonarConfig(serverUrl);

        const result = await harness.run('init');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toContain(INTEGRATE_PROMPT);
        expect(result.stdout).toContain("Next, run 'sonar integrate'");
      },
      TIMEOUT,
    );
  });

  describe('unbound project creation', () => {
    async function startServer(
      configure: (s: ReturnType<typeof newCloudServer>) => void = () => {},
    ) {
      const builder = newCloudServer();
      configure(builder);
      const server = await builder.start();
      harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
      return server;
    }

    function created(server: Awaited<ReturnType<typeof startServer>>) {
      return server.getRecordedRequests().filter((r) => r.path === '/api/projects/create');
    }

    it(
      'creates a private project with the given key and name, and maps it without a token',
      async () => {
        const server = await startServer();
        initGitRepo(harness.cwd.path);

        const result = await harness.run(
          'init --non-interactive --project my-key --name "My Project"',
        );

        expect(result.exitCode).toBe(0);
        const body = new URLSearchParams(created(server)[0].body);
        expect(body.get('project')).toBe('my-key');
        expect(body.get('name')).toBe('My Project');
        expect(body.get('visibility')).toBe('private');
        expect(body.get('organization')).toBe(ORG);
        const config = harness.cwd.file('.sonar-config.json').asText();
        expect(config).toContain('my-key');
        expect(config).not.toContain(TOKEN);
      },
      TIMEOUT,
    );

    it(
      'creates a public project with --visibility public and a generated key',
      async () => {
        const server = await startServer();
        withRemote(GITLAB_REMOTE);

        const result = await harness.run('init --non-interactive --visibility public');

        expect(result.exitCode).toBe(0);
        const body = new URLSearchParams(created(server)[0].body);
        expect(body.get('visibility')).toBe('public');
        expect(body.get('project')).toMatch(/^my-org_repository-[0-9a-f]{12}$/);
        expect(body.get('name')).toBe('repository');
      },
      TIMEOUT,
    );

    it(
      'maps the project it already created instead of creating it again',
      async () => {
        const { projectKey } = generateProjectProposal(
          harness.cwd.path,
          'https://gitlab.com/example/repository.git',
          ORG,
        );
        const server = await startServer((s) => s.withProject(projectKey));
        withRemote(GITLAB_REMOTE);

        const result = await harness.run('init --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('already exists');
        expect(created(server)).toHaveLength(0);
        expect(harness.cwd.file('.sonar-config.json').asText()).toContain(projectKey);
      },
      TIMEOUT,
    );

    it(
      'warns that --name and --visibility are ignored when it maps an existing project',
      async () => {
        const { projectKey } = generateProjectProposal(
          harness.cwd.path,
          'https://gitlab.com/example/repository.git',
          ORG,
        );
        const server = await startServer((s) => s.withProject(projectKey));
        withRemote(GITLAB_REMOTE);

        const result = await harness.run('init --non-interactive --name Foo --visibility public');

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('--name, --visibility ignored');
        expect(created(server)).toHaveLength(0);
      },
      TIMEOUT,
    );

    it(
      'refuses an explicit --project that is already taken',
      async () => {
        const server = await startServer((s) => s.withProject('taken'));
        initGitRepo(harness.cwd.path);

        const result = await harness.run('init --non-interactive --project taken');

        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain("Project 'taken' already exists");
        expect(created(server)).toHaveLength(0);
      },
      TIMEOUT,
    );

    it(
      'points to --project when the server rejects the key it cannot see (taken elsewhere)',
      async () => {
        await startServer((s) =>
          s.withProjectCreateRejected(
            JSON.stringify({
              errors: [{ msg: "Could not create Project, key already exists: 'elsewhere'" }],
            }),
          ),
        );
        initGitRepo(harness.cwd.path);

        const result = await harness.run('init --non-interactive --project elsewhere');

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain("Could not create project 'elsewhere'");
        expect(output).toContain('choose another --project');
      },
      TIMEOUT,
    );

    it(
      'rejects an invalid --visibility before signing in',
      async () => {
        const result = await harness.run('init --non-interactive --visibility internal');

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('--visibility must be private or public');
      },
      TIMEOUT,
    );

    it(
      'creates nothing and suggests sonar integrate when the user declines',
      async () => {
        harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: 'true' });
        const server = await startServer();
        initGitRepo(harness.cwd.path);

        const session = harness.runInteractive('init');
        await session.waitText('Project name');
        session.keyEnter();
        await session.waitText('Project visibility');
        session.keyEnter();
        await session.decline('Create this project');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(created(server)).toHaveLength(0);
        expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
        expect(result.stdout).toContain("Next, run 'sonar integrate'");
        expect(result.stdout).not.toContain(INTEGRATE_PROMPT);
      },
      TIMEOUT,
    );

    it(
      'does not suggest sonar integrate on a declined creation once anything is integrated',
      async () => {
        harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: 'true' });
        const server = await startServer();
        initGitRepo(harness.cwd.path);
        harness.state().withSqaaFeature(harness.cwd.path, 'integrated_project');

        const session = harness.runInteractive('init');
        await session.waitText('Project name');
        session.keyEnter();
        await session.waitText('Project visibility');
        session.keyEnter();
        await session.decline('Create this project');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(created(server)).toHaveLength(0);
        expect(result.stdout).not.toContain("'sonar integrate'");
      },
      TIMEOUT,
    );

    it(
      'warns that the project flags are ignored when another path runs',
      async () => {
        const serverUrl = await signInToCloud(() => {});
        initGitRepo(harness.cwd.path);
        writeSonarConfig(serverUrl);

        const result = await harness.run('init --non-interactive --name Foo --visibility public');

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('--name, --visibility ignored');
      },
      TIMEOUT,
    );
  });

  describe('sonar integrate suggestion', () => {
    it(
      'is skipped once anything is integrated',
      async () => {
        await signInToCloud(() => {});
        harness.state().withSqaaFeature(harness.cwd.path, 'integrated_project');

        const result = await harness.run('init');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(UNBOUND);
        expect(result.stdout).not.toContain("'sonar integrate'");
      },
      TIMEOUT,
    );
  });

  describe('interactive', () => {
    beforeEach(() => {
      harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: 'true' });
    });

    function withImportableRepo(alm: string, slug: string) {
      return (server: ReturnType<typeof newCloudServer>) =>
        server
          .withOrganizations([{ key: ORG, name: ORG, alm: { key: alm }, actions: { admin: true } }])
          .withDopRepositories(ORG, [{ id: 'repo-1', name: 'repository', slug }]);
    }

    it(
      'creates a bound project, maps it and never writes a token when the user agrees to bind',
      async () => {
        await signInToCloud(withImportableRepo('github', 'example/repository'));
        withRemote(GITHUB_REMOTE);

        const session = harness.runInteractive('init');
        await session.accept('Bind this repository');
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Created project');
        expect(result.stdout).not.toContain('The repository is bound');
        expect(result.stdout).toContain(
          'Project dashboard: https://sonarcloud.io/project/overview?id=',
        );
        const config = harness.cwd.file('.sonar-config.json').asText();
        expect(config).toContain('"projectKey"');
        expect(config).not.toContain(TOKEN);
      },
      TIMEOUT,
    );

    it(
      'looks the organization up once for the whole bind',
      async () => {
        const server = await withImportableRepo(
          'github',
          'example/repository',
        )(newCloudServer()).start();
        harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
        withRemote(GITHUB_REMOTE);

        const session = harness.runInteractive('init');
        await session.accept('Bind this repository');
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        const lookups = server
          .getRecordedRequests()
          .filter((r) => r.path === '/api/organizations/search' && r.query.organizations === ORG);
        expect(lookups).toHaveLength(1);
      },
      TIMEOUT,
    );

    it(
      'creates a bound project for an Azure DevOps SSH remote',
      async () => {
        await signInToCloud(withImportableRepo('azure', 'project/repository'));
        withRemote('git@ssh.dev.azure.com:v3/example/project/repository');

        const session = harness.runInteractive('init');
        await session.accept('Bind this repository');
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Created project');
      },
      TIMEOUT,
    );

    it(
      'creates a bound project for a legacy visualstudio.com remote',
      async () => {
        await signInToCloud(withImportableRepo('azure', 'project/repository'));
        withRemote('https://example.visualstudio.com/project/_git/repository');

        const session = harness.runInteractive('init');
        await session.accept('Bind this repository');
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Created project');
      },
      TIMEOUT,
    );

    it(
      'does not offer binding on SonarQube Server and says why',
      async () => {
        const server = await harness.newFakeServer().withAuthToken(TOKEN).start();
        harness.withAuth(server.recordedAuthServerUrl(), TOKEN);
        withRemote(GITHUB_REMOTE);

        const session = harness.runInteractive('init');
        await createProject(session);
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(UNBOUND);
        expect(result.stdout).not.toContain('Bind this repository');
        expect(result.stderr).toContain('only available on SonarQube Cloud');
      },
      TIMEOUT,
    );

    it(
      'waits for the DevOps platform authorization, then creates the bound project',
      async () => {
        await signInToCloud((server) =>
          server
            .withOrganizations([{ key: ORG, name: ORG, actions: { admin: true } }])
            .withDopRepositories(ORG, [
              { id: 'repo-1', name: 'repository', slug: 'example/repository' },
            ])
            .withOrganizationBindingAppearingAfter(ORG, 'github', 1),
        );
        withRemote(GITHUB_REMOTE);

        const session = harness.runInteractive('init');
        await session.accept('Bind this repository');
        await session.accept('Authorize it in the browser');
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`/organizations/${ORG}/edit?category=binding`);
        expect(result.stdout).toContain('Created project');
      },
      TIMEOUT,
    );

    it(
      'fails when the repository is not among those the DevOps platform lists',
      async () => {
        await signInToCloud((server) =>
          server
            .withOrganizations([
              { key: ORG, name: ORG, alm: { key: 'github' }, actions: { admin: true } },
            ])
            .withDopRepositories(ORG, []),
        );
        withRemote(GITHUB_REMOTE);

        const session = harness.runInteractive('init');
        await session.accept('Bind this repository');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain('example/repository');
        expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
      },
      TIMEOUT,
    );

    it(
      'does not offer binding for a remote whose repository cannot be derived',
      async () => {
        await signInToCloud(withImportableRepo('github', 'example/repository'));
        withRemote('https://github.com/example');

        const session = harness.runInteractive('init');
        await createProject(session);
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(UNBOUND);
        expect(result.stdout).not.toContain('Bind this repository');
      },
      TIMEOUT,
    );

    it(
      'warns when the new project replaces the mapping of the same directory',
      async () => {
        await signInToCloud(withImportableRepo('github', 'example/repository'));
        withRemote(GITHUB_REMOTE);
        writeSonarConfig('https://sq.example.com');

        const session = harness.runInteractive('init');
        await session.accept('Bind this repository');
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain(
          "Replacing the mapping of this directory to 'mapped'",
        );
        const config = JSON.parse(harness.cwd.file('.sonar-config.json').asText());
        expect(config.project.projectKey).not.toBe('mapped');
      },
      TIMEOUT,
    );

    it(
      'says the project was created and how to link it when the mapping cannot be saved',
      async () => {
        await signInToCloud(withImportableRepo('github', 'example/repository'));
        withRemote(GITHUB_REMOTE);
        harness.cwd.writeFile('.sonar-config.json', '{ not json');

        const session = harness.runInteractive('init');
        await session.accept('Bind this repository');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Created project');
        expect(output).toContain('could not save .sonar-config.json');
        expect(output).toContain('sonar link ');
      },
      TIMEOUT,
    );

    it(
      'creates a bound project for an Azure DevOps remote',
      async () => {
        await signInToCloud(withImportableRepo('azure', 'project/repository'));
        withRemote(AZURE_REMOTE);

        const session = harness.runInteractive('init');
        await session.accept('Bind this repository');
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Created project');
      },
      TIMEOUT,
    );

    it(
      'continues unbound when the user declines to authorize the organization',
      async () => {
        await signInToCloud((server) =>
          server.withOrganizations([{ key: ORG, name: ORG, actions: { admin: true } }]),
        );
        withRemote(GITHUB_REMOTE);

        const session = harness.runInteractive('init');
        await session.accept('Bind this repository');
        await session.decline('Authorize it in the browser');
        await createProject(session);
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(UNBOUND);
        expect(harness.cwd.exists('.sonar-config.json')).toBe(true);
      },
      TIMEOUT,
    );

    it(
      'selects the unbound path when the user declines to bind the repository',
      async () => {
        await signInToCloud(() => {});
        withRemote(GITHUB_REMOTE);

        const session = harness.runInteractive('init');
        await session.decline('Bind this repository');
        await createProject(session);
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(UNBOUND);
      },
      TIMEOUT,
    );

    it(
      'links the project already bound to the remote, shows its results and never writes a token',
      async () => {
        await signInToCloud((server) =>
          server
            .withGitRemoteBinding(GITHUB_REMOTE, 'bound_project')
            .withProject('bound_project', (p) => p.withProjectStatus('OK')),
        );
        withRemote(GITHUB_REMOTE);

        const session = harness.runInteractive('init');
        await session.accept('Link this directory');
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Linked this directory to project 'bound_project'");
        expect(result.stdout).toContain('not a result for your uncommitted local changes');
        expect(result.stdout).toContain('Quality gate: passed');
        expect(result.stdout).toContain(
          'Project dashboard: https://sonarcloud.io/project/overview?id=bound_project',
        );
        expect(result.stdout).not.toContain(UNBOUND);
        const config = harness.cwd.file('.sonar-config.json').asText();
        expect(config).toContain('"projectKey": "bound_project"');
        expect(config).not.toContain(TOKEN);
      },
      TIMEOUT,
    );

    it(
      'lets the user pick another existing project with the sonar link picker when declining',
      async () => {
        await signInToCloud((server) =>
          server
            .withGitRemoteBinding(GITHUB_REMOTE, 'bound_project')
            .withProject('other_project', (p) => p.withProjectStatus('OK')),
        );
        withRemote(GITHUB_REMOTE);

        const session = harness.runInteractive('init');
        await session.decline('Link this directory');
        await session.accept('another existing project');
        await session.waitText('Choose a project');
        session.write('other');
        await session.waitText('1 match');
        session.keyEnter();
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Linked this directory to project 'other_project'");
        expect(result.stdout).toContain('Quality gate: passed');
        const config = harness.cwd.file('.sonar-config.json').asText();
        expect(config).toContain('"projectKey": "other_project"');
        expect(config).not.toContain('bound_project');
        expect(config).not.toContain(TOKEN);
      },
      TIMEOUT,
    );

    it(
      'continues unbound and creates a project when the user declines every link',
      async () => {
        await signInToCloud((server) =>
          server.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project').withProject('other_project'),
        );
        withRemote(GITHUB_REMOTE);

        const session = harness.runInteractive('init');
        await session.decline('Link this directory');
        await session.decline('another existing project');
        await createProject(session);
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toContain('Choose a project');
        expect(result.stdout).toContain(UNBOUND);
        expect(harness.cwd.file('.sonar-config.json').exists()).toBe(true);
      },
      TIMEOUT,
    );

    it(
      'asks to abandon linking when the user leaves the project picker, then continues unbound',
      async () => {
        await signInToCloud((server) =>
          server.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project').withProject('other_project'),
        );
        withRemote(GITHUB_REMOTE);

        const session = harness.runInteractive('init');
        await session.decline('Link this directory');
        await session.accept('another existing project');
        await session.waitText('Choose a project');
        session.keyCtrlC();
        await session.waitText('Abandon linking a project');
        session.write('y');
        await createProject(session);
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).not.toContain('Project selection cancelled');
        expect(result.stdout).toContain(UNBOUND);
        expect(harness.cwd.file('.sonar-config.json').exists()).toBe(true);
      },
      TIMEOUT,
    );

    it(
      'reopens the project picker when the user does not abandon linking',
      async () => {
        await signInToCloud((server) =>
          server.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project').withProject('other_project'),
        );
        withRemote(GITHUB_REMOTE);

        const session = harness.runInteractive('init');
        await session.decline('Link this directory');
        await session.accept('another existing project');
        await session.waitText('Choose a project');
        session.keyCtrlC();
        await session.decline('Abandon linking a project');
        await session.waitText('other_project');
        session.keyEnter();
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Linked this directory to project 'other_project'");
      },
      TIMEOUT,
    );

    it(
      'fails with a sonar link hint, without creating a project, when the mapping cannot be written',
      async () => {
        await signInToCloud((server) =>
          server.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project'),
        );
        withRemote(GITHUB_REMOTE);
        harness.cwd.writeFile('.sonar-config.json', '{ not json');

        const session = harness.runInteractive('init');
        await session.accept('Link this directory');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain(
          "Found project 'bound_project', but could not save .sonar-config.json",
        );
        expect(output).toContain('sonar link bound_project');
        expect(output).not.toContain('Create this project');
        expect(output).not.toContain(UNBOUND);
      },
      TIMEOUT,
    );
  });
});
