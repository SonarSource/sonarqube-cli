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
const SCAN_PROMPT = 'Run the first analysis with sonar-scanner now';

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

  function withImportableRepo(alm: string, slug: string) {
    return (server: ReturnType<typeof newCloudServer>) =>
      server
        .withOrganizations([{ key: ORG, name: ORG, alm: { key: alm }, actions: { admin: true } }])
        .withDopRepositories(ORG, [{ id: 'repo-1', name: 'repository', slug }]);
  }

  /** Every successful run prints the dashboard link exactly once, before any integrate offer. */
  function expectDashboardBefore(stdout: string, id: string, integrateMarker: string) {
    expect(stdout.match(/Project dashboard:/g)).toHaveLength(1);
    const dashboardAt = stdout.indexOf(
      `Project dashboard: https://sonarcloud.io/project/overview?id=${id}`,
    );
    expect(dashboardAt).toBeGreaterThan(-1);
    const markerAt = stdout.indexOf(integrateMarker);
    expect(markerAt).toBeGreaterThan(-1);
    expect(dashboardAt).toBeLessThan(markerAt);
  }

  /** The prompts every created project goes through, up to confirming its creation. */
  async function confirmNewProject(session: ReturnType<typeof harness.runInteractive>) {
    await session.waitText('Project name');
    session.keyEnter();
    await session.waitText('Project visibility');
    session.keyEnter();
    await session.accept('Create this project');
  }

  async function createProject(session: ReturnType<typeof harness.runInteractive>) {
    await confirmNewProject(session);
    await session.decline(SCAN_PROMPT);
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
      const serverUrl = await signInToCloud((server) => server.withProject('mapped'));
      initGitRepo(harness.cwd.path);
      writeSonarConfig(serverUrl);

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("linked to the Sonar project 'mapped'");
      expect(result.stdout).not.toContain("'sonar integrate'");
      expect(result.stdout.match(/Project dashboard:/g)).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'warns, creates nothing and exits 0 when the linked project does not exist on the remote',
    async () => {
      const serverUrl = await signInToCloud(() => {});
      initGitRepo(harness.cwd.path);
      writeSonarConfig(serverUrl);

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        `.sonar-config.json links 'mapped', but no such project exists in organization ${ORG}.`,
      );
      expect(result.stderr).toContain("Relink with 'sonar link <project key>'");
      expect(result.stderr).toContain("or delete .sonar-config.json, then run 'sonar init' again");
      expect(result.stdout).not.toContain('Nothing left to set up');
      expect(result.stdout).not.toContain("linked to the Sonar project 'mapped'");
      expect(result.stdout).not.toContain(UNBOUND);
      expect(result.stdout).not.toContain('Project dashboard:');
    },
    TIMEOUT,
  );

  it(
    'warns separately when the linked project belongs to another organization',
    async () => {
      const serverUrl = await signInToCloud((server) =>
        server.withProject('mapped', (project) => project.withOrganization('other-org')),
      );
      initGitRepo(harness.cwd.path);
      writeSonarConfig(serverUrl);

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        "links 'mapped', which belongs to another organization or is not accessible with this token",
      );
      expect(result.stderr).not.toContain('no such project exists');
      expect(result.stdout).not.toContain(UNBOUND);
    },
    TIMEOUT,
  );

  it(
    'only notes that the link could not be checked when the lookup fails, and still reports setup as complete',
    async () => {
      const serverUrl = await signInToCloud((server) => server.withComponentShowStatus(500));
      initGitRepo(harness.cwd.path);
      writeSonarConfig(serverUrl);

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Could not check whether 'mapped' exists on the remote");
      expect(result.stderr).not.toContain('no such project exists');
      expect(result.stdout).toContain("linked to the Sonar project 'mapped'");
    },
    TIMEOUT,
  );

  it(
    'does not report setup as complete when .sonar-config.json maps another connection',
    async () => {
      await signInToCloud(() => {});
      initGitRepo(harness.cwd.path);
      writeSonarConfig('https://sq.example.com');

      const result = await harness.run('init --create');

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

      const result = await harness.run('init --path frontend --create');

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

      const result = await harness.run('init --create');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(UNBOUND);
      expect(result.stdout).not.toContain('Nothing left to set up');
    },
    TIMEOUT,
  );

  it(
    'reports setup as complete when .sonar-config.json sits in a directory between --path and the repository root',
    async () => {
      const serverUrl = await signInToCloud((server) => server.withProject('mapped'));
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

      const result = await harness.run('init --create');

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

      const result = await harness.run('init --create');

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

      // Linking needs an answer, so the non-interactive run stops and asks for --link.
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "A Sonar project already exists for this repository: 'bound_project'",
      );
      expect(result.stderr).toContain("Run 'sonar init' again with --link.");
    },
    TIMEOUT,
  );

  it(
    'finds the bound project for a remote that embeds credentials, without printing them',
    async () => {
      await signInToCloud((server) => server.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project'));
      withRemote('https://user:secret-token@github.com/example/repository.git');

      const result = await harness.run('init');

      expect(result.exitCode).toBe(2);
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

      const result = await harness.run('init --create');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(UNBOUND);
    },
    TIMEOUT,
  );

  it(
    'asks for --link instead of creating a second project when it cannot ask',
    async () => {
      await signInToCloud((server) => server.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project'));
      withRemote(GITHUB_REMOTE);

      const result = await harness.run('init');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "A Sonar project already exists for this repository: 'bound_project'",
      );
      expect(result.stderr).toContain("Run 'sonar init' again with --link.");
      expect(result.stdout).not.toContain(UNBOUND);
      expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'selects the unbound path without a prompt when there is no git remote',
    async () => {
      await signInToCloud(() => {});

      const result = await harness.run('init --create');

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

      const result = await harness.run('init --create');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(UNBOUND);
    },
    TIMEOUT,
  );

  it(
    'lists the options that pick a path when no project exists and nothing can be asked',
    async () => {
      const server = await newCloudServer().start();
      harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
      withRemote(GITHUB_REMOTE);

      const result = await harness.run('init --non-interactive');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('No Sonar project exists for this directory yet.');
      expect(result.stderr).toContain('one of --bind, --create, --link <key>');
      expect(server.getRecordedRequests().some((r) => r.path === '/api/projects/create')).toBe(
        false,
      );
      expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'leaves --bind out of the options it lists when the remote cannot be bound',
    async () => {
      await signInToCloud(() => {});
      withRemote(GITLAB_REMOTE);

      const result = await harness.run('init --non-interactive');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('one of --create, --link <key>');
      expect(result.stderr).not.toContain('--bind');
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
      'ends without any integrate output when the user declines',
      async () => {
        const server = await startOrglessServer();
        pointAtServer(server);

        const session = harness.runInteractive('init', { browserToken: TOKEN });
        await session.decline(CREATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No organization was created.');
        expect(result.stdout).toContain('An organization holds your projects');
        expect(result.stdout).not.toContain('sonar integrate');
        expect(result.stdout).not.toContain(INTEGRATE_PROMPT);
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
        .withProject('p')
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
        expect(result.stdout).not.toContain("'sonar integrate'");
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
          'init --non-interactive --create --project my-key --name "My Project"',
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

        const result = await harness.run('init --non-interactive --create --visibility public');

        expect(result.exitCode).toBe(0);
        const body = new URLSearchParams(created(server)[0].body);
        expect(body.get('visibility')).toBe('public');
        expect(body.get('project')).toMatch(/^my-org_repository-[0-9a-f]{12}$/);
        expect(body.get('name')).toBe('repository');
      },
      TIMEOUT,
    );

    describe('when the generated key already exists', () => {
      async function startWithExistingProject() {
        const { projectKey } = generateProjectProposal(
          harness.cwd.path,
          'https://gitlab.com/example/repository.git',
          ORG,
        );
        const server = await startServer((s) => s.withProject(projectKey));
        withRemote(GITLAB_REMOTE);
        harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: 'true' });
        return { projectKey, server };
      }

      /** Declines linking the project, and linking another one, which leads to the key prompt. */
      async function declineLinking(session: ReturnType<typeof harness.runInteractive>) {
        await session.decline('Link this directory');
        await session.decline('another existing project');
      }

      async function finishCreation(session: ReturnType<typeof harness.runInteractive>) {
        await session.waitText('Project name');
        session.keyEnter();
        await session.waitText('Project visibility');
        session.keyEnter();
        await session.accept('Create this project');
        await session.decline(SCAN_PROMPT);
        await session.decline(INTEGRATE_PROMPT);
        return session.waitFinish();
      }

      it(
        'asks for --link instead of mapping it when nothing can be asked',
        async () => {
          const { projectKey, server } = await startWithExistingProject();

          const result = await harness.run('init --non-interactive');

          expect(result.exitCode).toBe(2);
          expect(result.stderr).toContain(
            `A Sonar project already exists for this repository: '${projectKey}'`,
          );
          expect(result.stderr).toContain("Run 'sonar init' again with --link.");
          expect(created(server)).toHaveLength(0);
          expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
        },
        TIMEOUT,
      );

      it(
        'maps it without asking with --link',
        async () => {
          const { projectKey, server } = await startWithExistingProject();

          const result = await harness.run('init --non-interactive --link');

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain(`Linked this directory to project '${projectKey}'`);
          expect(created(server)).toHaveLength(0);
          expect(harness.cwd.file('.sonar-config.json').asText()).toContain(projectKey);
        },
        TIMEOUT,
      );

      it(
        'refuses --create rather than adopting or duplicating it',
        async () => {
          const { projectKey, server } = await startWithExistingProject();

          const result = await harness.run('init --non-interactive --create');

          expect(result.exitCode).toBe(2);
          expect(result.stderr).toContain(`Project '${projectKey}', the key generated`);
          expect(result.stderr).toContain('--project <key>');
          expect(created(server)).toHaveLength(0);
          expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
        },
        TIMEOUT,
      );

      it(
        'maps it only when the user accepts, without offering a first analysis',
        async () => {
          const { projectKey, server } = await startWithExistingProject();

          const session = harness.runInteractive('init --name Foo --visibility public');
          await session.accept('Link this directory');
          await session.decline(INTEGRATE_PROMPT);
          const result = await session.waitFinish();

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain(`Linked this directory to project '${projectKey}'`);
          expect(result.stdout).not.toContain(SCAN_PROMPT);
          expect(result.stdout).not.toContain('Created project');
          expect(result.stdout.match(/Project dashboard:/g)).toHaveLength(1);
          expect(result.stderr).toContain('--name, --visibility ignored');
          expect(created(server)).toHaveLength(0);
          expect(harness.cwd.file('.sonar-config.json').asText()).toContain(projectKey);
        },
        TIMEOUT,
      );

      it(
        'creates a project under the key the user chooses when linking is declined',
        async () => {
          const { projectKey, server } = await startWithExistingProject();

          const session = harness.runInteractive('init');
          await declineLinking(session);
          await session.waitText('Project key');
          session.write(projectKey);
          session.keyEnter();
          await session.waitText(`default: ${projectKey}-3`);
          session.write('my-chosen-key');
          session.keyEnter();
          const result = await finishCreation(session);

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain('Project key: my-chosen-key');
          expect(result.stderr).toContain(`Project '${projectKey}' already exists.`);
          const [request] = created(server);
          expect(new URLSearchParams(request.body).get('project')).toBe('my-chosen-key');
          const config = harness.cwd.file('.sonar-config.json').asText();
          expect(config).toContain('my-chosen-key');
          expect(config).not.toContain(`"${projectKey}"`);
        },
        TIMEOUT,
      );

      it(
        'suggests the generated key with a numeric suffix as the default',
        async () => {
          const { projectKey, server } = await startWithExistingProject();

          const session = harness.runInteractive('init');
          await declineLinking(session);
          await session.waitText(`default: ${projectKey}-2`);
          session.keyEnter();
          const result = await finishCreation(session);

          expect(result.exitCode).toBe(0);
          const [request] = created(server);
          expect(new URLSearchParams(request.body).get('project')).toBe(`${projectKey}-2`);
        },
        TIMEOUT,
      );
    });

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

        const result = await harness.run('init --non-interactive --create --project elsewhere');

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain("Could not create project 'elsewhere'");
        expect(output).toContain('choose another key');
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
      'creates nothing and offers sonar integrate when the user declines',
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
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(created(server)).toHaveLength(0);
        expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
        expect(result.stdout).not.toContain("Next, run 'sonar integrate'");
      },
      TIMEOUT,
    );

    it(
      'does not offer sonar integrate on a declined creation once anything is integrated',
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

  describe('--dry-run', () => {
    function createRequests(
      server: Awaited<ReturnType<ReturnType<typeof newCloudServer>['start']>>,
    ) {
      return server.getRecordedRequests().filter((r) => r.path === '/api/projects/create');
    }

    it(
      'previews the project it would create without creating or saving anything',
      async () => {
        const server = await newCloudServer().start();
        harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
        initGitRepo(harness.cwd.path);

        const result = await harness.run(
          'init --non-interactive --create --project my-key --name "My Project" --dry-run',
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('DRY RUN: no changes will be made');
        expect(result.stdout).toContain("Would create the project 'My Project' (key 'my-key'");
        expect(result.stdout).toContain('Dry run: nothing was written');
        expect(result.stdout).not.toContain('Project dashboard:');
        expect(result.stderr).not.toContain('ignored');
        expect(createRequests(server)).toHaveLength(0);
        expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
      },
      TIMEOUT,
    );

    it(
      'previews binding the repository without importing it',
      async () => {
        const server = await newCloudServer()
          .withOrganizations([
            { key: ORG, name: ORG, alm: { key: 'github' }, actions: { admin: true } },
          ])
          .withDopRepositories(ORG, [
            { id: 'repo-1', name: 'repository', slug: 'example/repository' },
          ])
          .start();
        harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
        withRemote(GITHUB_REMOTE);

        const result = await harness.run(
          'init --non-interactive --bind --project unused-key --dry-run',
        );

        expect(result.exitCode).toBe(0);
        // A bound project takes its key from the import, so the real run ignores --project too.
        expect(result.stderr).toContain('--project ignored');
        expect(result.stdout).toContain(
          "Would create a project bound to the repository 'example/repository'",
        );
        expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
      },
      TIMEOUT,
    );

    it(
      'fails like the real run when --bind needs a browser authorization without a terminal',
      async () => {
        const server = await newCloudServer()
          .withOrganizations([{ key: ORG, name: ORG, actions: { admin: true } }])
          .start();
        harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
        withRemote(GITHUB_REMOTE);

        const result = await harness.run('init --non-interactive --bind --dry-run');

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          `Organization '${ORG}' is not linked to your DevOps platform`,
        );
        expect(result.stderr).toContain(`/organizations/${ORG}/edit?category=binding`);
        expect(result.stdout).not.toContain('Would create a project bound');
      },
      TIMEOUT,
    );

    it(
      'still asks for the missing consent a real run would need',
      async () => {
        const server = await newCloudServer().start();
        harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
        initGitRepo(harness.cwd.path);

        const result = await harness.run('init --non-interactive --dry-run');

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('No Sonar project exists for this directory yet.');
      },
      TIMEOUT,
    );

    it(
      'does not sign in, since that saves credentials',
      async () => {
        const result = await harness.run('init --non-interactive --dry-run');

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('a dry run cannot sign in');
      },
      TIMEOUT,
    );

    it(
      'rejects the options that shape the first analysis',
      async () => {
        const result = await harness.run('init --non-interactive --dry-run --scan --detach');

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('--scan, --detach cannot be combined with --dry-run');
      },
      TIMEOUT,
    );
  });

  describe('first analysis flags', () => {
    it(
      'rejects --detach together with --verbose before signing in',
      async () => {
        const result = await harness.run('init --non-interactive --detach --verbose');

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('--detach cannot be combined with --verbose');
      },
      TIMEOUT,
    );

    it(
      'rejects a managed scanner property without echoing its value',
      async () => {
        const result = await harness.run(
          'init --non-interactive --scanner-property sonar.token=hunter2-secret',
        );

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("'sonar.token' is managed by 'sonar init'");
        expect(result.stderr).not.toContain('hunter2-secret');
      },
      TIMEOUT,
    );

    it(
      'creates the project but runs no analysis without a terminal or a scan flag',
      async () => {
        await signInToCloud(() => {});
        initGitRepo(harness.cwd.path);

        const result = await harness.run('init --non-interactive --create');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(UNBOUND);
        expect(result.stdout).not.toContain('Analysis');
        expect(result.stdout.match(/Project dashboard:/g)).toHaveLength(1);
        expect(result.stdout).not.toContain("'sonar integrate'");
      },
      TIMEOUT,
    );

    it(
      'warns that scan flags are ignored when the directory is already set up',
      async () => {
        const serverUrl = await signInToCloud(() => {});
        initGitRepo(harness.cwd.path);
        writeSonarConfig(serverUrl);

        const result = await harness.run(
          'init --non-interactive --detach --scanner-property sonar.exclusions=build/**',
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('--scanner-property, --detach ignored');
        expect(result.stderr).not.toContain('build/**');
      },
      TIMEOUT,
    );
  });

  describe('sonar integrate offer', () => {
    it(
      'is skipped once anything is integrated',
      async () => {
        await signInToCloud(() => {});
        harness.state().withSqaaFeature(harness.cwd.path, 'integrated_project');

        const result = await harness.run('init --create');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(UNBOUND);
        expect(result.stdout).not.toContain("'sonar integrate'");
      },
      TIMEOUT,
    );
  });

  describe('intent options', () => {
    function projectsCreated(server: FakeSonarQubeServer) {
      return server.getRecordedRequests().filter((r) => r.path === '/api/projects/create');
    }

    it(
      'rejects two intent options together before signing in',
      async () => {
        const result = await harness.run('init --non-interactive --link --create');

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('--link, --create cannot be combined');
      },
      TIMEOUT,
    );

    it(
      'rejects an intent option together with --monorepo',
      async () => {
        const result = await harness.run('init --monorepo --non-interactive --create');

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('--create does not apply with --monorepo');
      },
      TIMEOUT,
    );

    it(
      'links the project bound to the repository with --link',
      async () => {
        await signInToCloud((server) =>
          server.withProject('bound_project').withGitRemoteBinding(GITHUB_REMOTE, 'bound_project'),
        );
        withRemote(GITHUB_REMOTE);

        const result = await harness.run('init --non-interactive --link');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Linked this directory to project 'bound_project'");
        expect(harness.cwd.file('.sonar-config.json').asText()).toContain('bound_project');
      },
      TIMEOUT,
    );

    it(
      'refuses --create and --bind for a repository that already has a project',
      async () => {
        await signInToCloud((server) =>
          server.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project'),
        );
        withRemote(GITHUB_REMOTE);

        for (const option of ['--create', '--bind']) {
          const result = await harness.run(`init --non-interactive ${option}`);

          expect(result.exitCode).toBe(2);
          expect(result.stderr).toContain(`${option} would create a second project for it`);
          expect(result.stderr).toContain("Run 'sonar init' again with --link to link it.");
        }
        expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
      },
      TIMEOUT,
    );

    it(
      'links the project named with --link <key>, without creating one',
      async () => {
        const server = await newCloudServer().withProject('chosen').start();
        harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
        withRemote(GITHUB_REMOTE);

        const result = await harness.run('init --non-interactive --link chosen');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Linked this directory to project 'chosen'");
        expect(projectsCreated(server)).toHaveLength(0);
      },
      TIMEOUT,
    );

    it(
      'fails when --link <key> names a project that does not exist',
      async () => {
        await signInToCloud(() => {});
        initGitRepo(harness.cwd.path);

        const result = await harness.run('init --non-interactive --link missing');

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("--link names project 'missing', which does not exist");
        expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
      },
      TIMEOUT,
    );

    it(
      'asks for a key when --link finds no project',
      async () => {
        await signInToCloud(() => {});
        withRemote(GITHUB_REMOTE);

        const result = await harness.run('init --non-interactive --link');

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('--link found no Sonar project for this directory');
        expect(result.stderr).toContain('--link <key>');
      },
      TIMEOUT,
    );

    it(
      'says why --bind is unavailable instead of creating an unbound project',
      async () => {
        const server = await newCloudServer().start();
        harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
        withRemote(GITLAB_REMOTE);

        const result = await harness.run('init --non-interactive --bind');

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain(
          '--bind is unavailable: the git remote is not a GitHub or Azure DevOps repository.',
        );
        expect(result.stderr).toContain('--create');
        expect(projectsCreated(server)).toHaveLength(0);
      },
      TIMEOUT,
    );

    it(
      'says --bind needs a git remote when there is none',
      async () => {
        await signInToCloud(() => {});
        initGitRepo(harness.cwd.path);

        const result = await harness.run('init --non-interactive --bind');

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('--bind is unavailable: this directory has no git remote.');
      },
      TIMEOUT,
    );

    it(
      'creates a bound project without asking with --bind',
      async () => {
        await signInToCloud(withImportableRepo('github', 'example/repository'));
        withRemote(GITHUB_REMOTE);

        const result = await harness.run('init --non-interactive --bind');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Created project');
        expect(harness.cwd.file('.sonar-config.json').asText()).toContain('"projectKey"');
      },
      TIMEOUT,
    );

    it(
      'fails with the authorization link when --bind needs the organization linked first',
      async () => {
        const server = await newCloudServer()
          .withOrganizations([{ key: ORG, name: ORG, actions: { admin: true } }])
          .start();
        harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
        withRemote(GITHUB_REMOTE);

        const result = await harness.run('init --non-interactive --bind');

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          `Organization '${ORG}' is not linked to your DevOps platform`,
        );
        expect(result.stderr).toContain(`/organizations/${ORG}/edit?category=binding`);
        expect(projectsCreated(server)).toHaveLength(0);
        expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
      },
      TIMEOUT,
    );

    it(
      'warns that the intent is ignored when the directory is already set up',
      async () => {
        const serverUrl = await signInToCloud((server) => server.withProject('mapped'));
        initGitRepo(harness.cwd.path);
        writeSonarConfig(serverUrl);

        const result = await harness.run('init --non-interactive --link other');

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain(
          "--link ignored: this directory is already linked in .sonar-config.json. To link it to 'other' instead, run 'sonar link other'.",
        );
      },
      TIMEOUT,
    );
  });

  describe('interactive', () => {
    beforeEach(() => {
      harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: 'true' });
    });

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
        expect(result.stdout.match(/Project dashboard:/g)).toHaveLength(1);
        expect(result.stdout.indexOf('Project dashboard:')).toBeLessThan(
          result.stdout.indexOf(INTEGRATE_PROMPT),
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
      'prints the project dashboard once, between the first-analysis and integrate prompts',
      async () => {
        await signInToCloud(() => {});
        initGitRepo(harness.cwd.path);

        const session = harness.runInteractive('init');
        await createProject(session);
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout.match(/Project dashboard:/g)).toHaveLength(1);
        const dashboardAt = result.stdout.indexOf('Project dashboard:');
        const scanPromptAt = result.stdout.indexOf(SCAN_PROMPT);
        const integratePromptAt = result.stdout.indexOf(INTEGRATE_PROMPT);
        expect(scanPromptAt).toBeGreaterThan(-1);
        expect(dashboardAt).toBeGreaterThan(scanPromptAt);
        expect(integratePromptAt).toBeGreaterThan(dashboardAt);
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
        expectDashboardBefore(result.stdout, 'bound_project', INTEGRATE_PROMPT);
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
        expect(output).toContain('Add --monorepo to keep the other links in .sonar-config.json.');
        expect(output).not.toContain('Create this project');
        expect(output).not.toContain(UNBOUND);
      },
      TIMEOUT,
    );

    it(
      'keeps the could-not-save error and hint when the config cannot be read at all',
      async () => {
        await signInToCloud((server) =>
          server.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project'),
        );
        withRemote(GITHUB_REMOTE);
        harness.cwd.writeFile('.sonar-config.json/.keep', '');

        const session = harness.runInteractive('init');
        await session.accept('Link this directory');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain(
          "Found project 'bound_project', but could not save .sonar-config.json",
        );
        expect(output).toContain('sonar link bound_project');
      },
      TIMEOUT,
    );
  });

  describe('monorepo', () => {
    const STALE_SERVER = 'https://sq.example.com';

    beforeEach(() => {
      harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: 'true' });
    });

    interface Root {
      path: string;
      key: string;
      /** Records another connection than the active one, as a mapping written elsewhere would. */
      stale?: boolean;
    }

    function writeMonorepoConfig(serverUrl: string, roots: Root[]) {
      initGitRepo(harness.cwd.path);
      for (const root of roots) {
        harness.cwd.writeFile(`${root.path}/.keep`, '');
      }
      harness.cwd.writeFile(
        '.sonar-config.json',
        JSON.stringify({
          projects: roots.map(({ path, key, stale }) =>
            stale
              ? { projectKey: key, path, serverUrl: STALE_SERVER }
              : { projectKey: key, path, serverUrl, organization: ORG },
          ),
        }),
      );
    }

    interface WrittenConfig {
      project?: unknown;
      projects: { projectKey: string; path: string; serverUrl?: string }[];
    }

    function readConfig(): WrittenConfig {
      return JSON.parse(harness.cwd.file('.sonar-config.json').asText()) as WrittenConfig;
    }

    it(
      'points to --root, and not to sonar link, when nothing is mapped, changing no file',
      async () => {
        await signInToCloud(() => {});
        initGitRepo(harness.cwd.path);

        const result = await harness.run('init --monorepo --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No project root is mapped in .sonar-config.json');
        expect(result.stdout).toContain('sonar init --monorepo --root <path>[=<project key>]');
        expect(result.stdout).not.toContain('sonar link');
        expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
      },
      TIMEOUT,
    );

    it(
      'confirms each root of the file on the remote and warns, without creating anything, about one it lacks, even without a terminal',
      async () => {
        const serverUrl = await signInToCloud((server) => server.withProject('api-key'));
        writeMonorepoConfig(serverUrl, [
          { path: 'api', key: 'api-key', stale: true },
          { path: 'web', key: 'web-key' },
        ]);
        const before = harness.cwd.file('.sonar-config.json').asText();

        const result = await harness.run('init --monorepo --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Already configured (1):');
        expect(result.stdout).toContain('api: api-key');
        expect(result.stdout).not.toContain('Created');
        expect(result.stdout).toContain('Skipped (1):');
        expect(result.stdout).toContain('web: web-key (not found on the remote)');
        expect(result.stdout).not.toContain('To resume');
        expect(result.stderr).toContain(
          `.sonar-config.json links 'web-key' (web), but no such project exists in organization ${ORG}.`,
        );
        expect(result.stderr).toContain("Relink with 'sonar link <project key>'");
        expect(harness.cwd.file('.sonar-config.json').asText()).toBe(before);
      },
      TIMEOUT,
    );

    it(
      'warns about a missing linked root before it asks anything about the roots it creates',
      async () => {
        const serverUrl = await signInToCloud(() => {});
        writeMonorepoConfig(serverUrl, [{ path: 'api', key: 'api-key' }]);
        harness.cwd.writeFile('web/.keep', '');

        const session = harness.runInteractive(
          'init --monorepo --root api=api-key --root web=web-key',
        );
        await session.waitText('Project name');
        const beforeFirstPrompt = session.output();
        session.keyEnter();
        await session.waitText('Project visibility');
        session.keyEnter();
        await session.accept('Create this project');
        await session.decline(INTEGRATE_PROMPT);
        await session.waitFinish();

        expect(beforeFirstPrompt).toContain("links 'api-key' (api), but no such project exists");
      },
      TIMEOUT,
    );

    it(
      'warns separately about a root whose project belongs to another organization',
      async () => {
        const serverUrl = await signInToCloud((server) =>
          server.withProject('foreign-key', (project) => project.withOrganization('other-org')),
        );
        writeMonorepoConfig(serverUrl, [{ path: 'api', key: 'foreign-key' }]);

        const result = await harness.run('init --monorepo --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain(
          "links 'foreign-key' (api), which belongs to another organization",
        );
        expect(result.stdout).not.toContain('Already configured');
      },
      TIMEOUT,
    );

    it(
      'only notes a root it could not check when the lookup fails',
      async () => {
        const serverUrl = await signInToCloud((server) => server.withComponentShowStatus(500));
        writeMonorepoConfig(serverUrl, [{ path: 'api', key: 'api-key' }]);

        const result = await harness.run('init --monorepo --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("Could not check whether 'api-key' (api) exists");
        expect(result.stderr).not.toContain('no such project exists');
      },
      TIMEOUT,
    );

    it(
      'leaves an already configured root alone, asks nothing and runs no scan',
      async () => {
        const serverUrl = await signInToCloud((server) => server.withProject('api-key'));
        writeMonorepoConfig(serverUrl, [{ path: 'api', key: 'api-key' }]);
        const before = harness.cwd.file('.sonar-config.json').asText();

        const session = harness.runInteractive('init --monorepo');
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Already configured (1):');
        expect(result.stdout).toContain('api: api-key');
        expect(result.stdout).not.toContain(SCAN_PROMPT);
        expect(harness.cwd.file('.sonar-config.json').asText()).toBe(before);
      },
      TIMEOUT,
    );

    it(
      'reads the roots of a nested config, reports them as configured and warns where mappings are saved',
      async () => {
        const serverUrl = await signInToCloud((server) =>
          server.withProject('api-key').withProject('web-key'),
        );
        initGitRepo(harness.cwd.path);
        harness.cwd.writeFile(
          '.sonar-config.json',
          JSON.stringify({
            project: { projectKey: 'api-key', path: '.', serverUrl, organization: ORG },
          }),
        );
        harness.cwd.writeFile('sub/web/.keep', '');
        harness.cwd.writeFile(
          'sub/.sonar-config.json',
          JSON.stringify({
            projects: [
              { projectKey: 'api-key', path: '.', serverUrl: STALE_SERVER },
              { projectKey: 'web-key', path: 'web', serverUrl, organization: ORG },
            ],
          }),
        );

        const result = await harness.run('init --monorepo --non-interactive --path sub');

        expect(result.stdout + result.stderr).toContain(
          'mappings will be saved to the .sonar-config.json at the repository root',
        );
        expect(result.stdout).toContain('Already configured (2):');
      },
      TIMEOUT,
    );

    it(
      'does not offer the monorepo flow in plain init for a config with several roots',
      async () => {
        const serverUrl = await signInToCloud((server) => server.withProject('api-key'));
        writeMonorepoConfig(serverUrl, [
          { path: '.', key: 'api-key' },
          { path: 'web', key: 'web-key' },
        ]);

        const session = harness.runInteractive('init');
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.stdout).not.toContain('Onboard it as a monorepo');
        expect(result.stdout).toContain('Nothing left to set up');
        expect(result.stdout).not.toContain('Monorepo onboarding summary:');
      },
      TIMEOUT,
    );

    it(
      'takes the usual path in plain init for an empty projects array',
      async () => {
        await signInToCloud(() => {});
        initGitRepo(harness.cwd.path);
        harness.cwd.writeFile('.sonar-config.json', JSON.stringify({ projects: [] }));

        const session = harness.runInteractive('init');
        await createProject(session);
        await session.decline(INTEGRATE_PROMPT);
        const result = await session.waitFinish();

        expect(result.stdout).not.toContain('No project root is mapped');
      },
      TIMEOUT,
    );

    describe('with --root', () => {
      function createdKeys(server: FakeSonarQubeServer) {
        return server
          .getRecordedRequests()
          .filter((request) => request.path === '/api/projects/create')
          .map((request) => new URLSearchParams(request.body).get('project'));
      }

      async function startServer(configure: (s: FakeSonarQubeServerBuilder) => void) {
        const builder = newCloudServer();
        configure(builder);
        const server = await builder.start();
        harness.withAuth(server.recordedAuthServerUrl(), TOKEN, ORG);
        return server;
      }

      /** A file with one link holds it as `project`, with several as a `projects` array. */
      function linkedRoots() {
        const { project, projects } = readConfig() as { project?: object; projects?: object[] };
        return projects ?? (project ? [project] : []);
      }

      function makeRepository(...directories: string[]) {
        initGitRepo(harness.cwd.path);
        for (const directory of directories) {
          harness.cwd.writeFile(`${directory}/.keep`, '');
        }
      }

      it(
        'maps an existing project and creates a missing one without a config file or a prompt',
        async () => {
          const server = await startServer((s) => s.withProject('api-key'));
          makeRepository('api', 'web');

          const result = await harness.run(
            'init --monorepo --non-interactive --root api=api-key --root web=web-key',
          );

          expect(result.exitCode).toBe(0);
          expect(createdKeys(server)).toEqual(['web-key']);
          expect(
            readConfig()
              .projects.map(({ projectKey, path }) => `${path}=${projectKey}`)
              .sort(),
          ).toEqual(['api=api-key', 'web=web-key']);
        },
        TIMEOUT,
      );

      it(
        'previews the roots as a preview, creating and mapping nothing',
        async () => {
          const server = await startServer((s) => s.withProject('api-key'));
          makeRepository('api', 'web');

          const result = await harness.run(
            'init --monorepo --non-interactive --dry-run --root api=api-key --root web=web-key',
          );

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain('Previewing web');
          expect(result.stdout).not.toContain('Onboarding web');
          expect(result.stdout).toContain('Monorepo onboarding preview:');
          expect(result.stdout).toContain('Would be created (1):');
          expect(result.stdout).toContain('Would be mapped to the existing project (1):');
          expect(result.stdout).not.toContain('To resume');
          expect(createdKeys(server)).toEqual([]);
          expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
        },
        TIMEOUT,
      );

      it(
        'leaves a root that the file already links to the same project as it is',
        async () => {
          const server = await startServer((s) => s.withProject('api-key'));
          makeRepository('api');
          const command = 'init --monorepo --non-interactive --root api=api-key';

          await harness.run(command);
          const rerun = await harness.run(command);

          expect(rerun.exitCode).toBe(0);
          expect(rerun.stdout).toContain('Already configured (1)');
          expect(createdKeys(server)).toEqual([]);
        },
        TIMEOUT,
      );

      it(
        'fails only the root that the file maps to another project',
        async () => {
          const serverUrl = await signInToCloud((s) => s.withProject('api-key'));
          writeMonorepoConfig(serverUrl, [{ path: 'api', key: 'other-key' }]);
          harness.cwd.writeFile('web/.keep', '');

          const result = await harness.run(
            'init --monorepo --non-interactive --root api=api-key --root web=web-key',
          );

          const output = result.stdout + result.stderr;
          expect(output).toContain("api is already mapped to 'other-key'");
          expect(output).toContain("Remap it with 'sonar link --monorepo api-key --path api'.");
          expect(output).not.toContain('Failed');
          expect(output).toContain('Skipped (1):');
          expect(output).toContain("api: api-key (already mapped to 'other-key')");
          expect(output).not.toContain('To resume');
          expect(readConfig().projects.find(({ path }) => path === 'api')?.projectKey).toBe(
            'other-key',
          );
          expect(readConfig().projects.some(({ projectKey }) => projectKey === 'web-key')).toBe(
            true,
          );
        },
        TIMEOUT,
      );

      it(
        'names a created root from the git remote, as it does when generating its key',
        async () => {
          const server = await startServer(() => {});
          withRemote(GITLAB_REMOTE);

          const result = await harness.run('init --monorepo --non-interactive --root .=web-key');

          expect(result.exitCode).toBe(0);
          const [request] = server
            .getRecordedRequests()
            .filter(({ path }) => path === '/api/projects/create');
          expect(new URLSearchParams(request.body).get('name')).toBe('repository');
        },
        TIMEOUT,
      );

      it(
        'generates, prints and records the key of a root named without one',
        async () => {
          const server = await startServer(() => {});
          makeRepository('web');
          const command = 'init --monorepo --non-interactive --root web';

          const first = await harness.run(command);

          expect(first.exitCode).toBe(0);
          const [key] = createdKeys(server);
          expect(key).toMatch(/^my-org_web-[0-9a-f]{12}$/);
          expect(first.stdout).toContain(`Generated project key for web: ${key}`);
          expect(linkedRoots()).toMatchObject([{ path: 'web', projectKey: key }]);
        },
        TIMEOUT,
      );

      it(
        'reuses the key the file already records for a root named without one, and leaves it as it is',
        async () => {
          const serverUrl = await signInToCloud((s) => s.withProject('api-key'));
          writeMonorepoConfig(serverUrl, [{ path: 'api', key: 'api-key', stale: true }]);
          const before = harness.cwd.file('.sonar-config.json').asText();

          const result = await harness.run('init --monorepo --non-interactive --root api');

          expect(result.exitCode).toBe(0);
          expect(result.stdout).not.toContain('Generated project key');
          expect(result.stdout).toContain('Already configured (1)');
          expect(harness.cwd.file('.sonar-config.json').asText()).toBe(before);
        },
        TIMEOUT,
      );

      it(
        'rejects a path that is not a directory of the repository before touching anything',
        async () => {
          const server = await startServer(() => {});
          makeRepository('api');

          const result = await harness.run(
            'init --monorepo --non-interactive --root api=api-key --root missing=web-key',
          );

          expect(result.exitCode).toBe(2);
          expect(result.stdout + result.stderr).toContain(
            '--root path "missing" must point to an existing directory',
          );
          expect(createdKeys(server)).toEqual([]);
          expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
        },
        TIMEOUT,
      );

      it(
        'is refused without --monorepo',
        async () => {
          await startServer(() => {});
          makeRepository('api');

          const result = await harness.run('init --non-interactive --root api=api-key');

          expect(result.exitCode).toBe(2);
          expect(result.stdout + result.stderr).toContain(
            '--root only applies together with --monorepo',
          );
        },
        TIMEOUT,
      );
    });
  });
});
