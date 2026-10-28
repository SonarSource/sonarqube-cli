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

import { ALPHA_ENV_VAR } from '@/core/commands/stage.ts';

import { TestHarness } from '../../harness';
import { git, initGitRepo } from '../hook/git-test-helpers.ts';

const TOKEN = 'init-token';
const ORG = 'my-org';
const GITHUB_REMOTE = 'https://github.com/example/repository.git';
const AZURE_REMOTE = 'https://dev.azure.com/example/project/_git/repository';
const GITLAB_REMOTE = 'https://gitlab.com/example/repository.git';
const TIMEOUT = { timeout: 30000 };

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

  const UNBOUND = 'create a new project without repository binding';

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

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound_project');
    },
    TIMEOUT,
  );

  it(
    'finds the bound project for a remote that embeds credentials, without printing them',
    async () => {
      await signInToCloud((server) => server.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project'));
      withRemote('https://user:secret-token@github.com/example/repository.git');

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound_project');
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
    'selects the link-existing path when the remote is already bound to a project',
    async () => {
      await signInToCloud((server) => server.withGitRemoteBinding(GITHUB_REMOTE, 'bound_project'));
      withRemote(GITHUB_REMOTE);

      const result = await harness.run('init');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        'A Sonar project already exists for this repository: bound_project.',
      );
      expect(result.stdout).toContain('link the existing project');
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

  it(
    'fails without suggesting sonar integrate when the account belongs to no organization',
    async () => {
      harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: 'true' });
      const server = await newCloudServer().withOrganizations([]).start();
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
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('not a member of any organization');
      expect(result.stdout).not.toContain("'sonar integrate'");
    },
    TIMEOUT,
  );

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
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("linked to the Sonar project 'p'");
    },
    TIMEOUT,
  );

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
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('bound to the new Sonar project');
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
      'creates a bound project for an Azure DevOps remote',
      async () => {
        await signInToCloud(withImportableRepo('azure', 'project/repository'));
        withRemote(AZURE_REMOTE);

        const session = harness.runInteractive('init');
        await session.accept('Bind this repository');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('bound to the new Sonar project');
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
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(UNBOUND);
        expect(harness.cwd.exists('.sonar-config.json')).toBe(false);
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
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(UNBOUND);
      },
      TIMEOUT,
    );
  });
});
