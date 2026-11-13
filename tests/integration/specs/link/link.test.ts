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

import { mkdirSync } from 'node:fs';
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
      project: { serverUrl: SERVER_URL, projectKey: 'my_project', path: '.' },
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
        project: { serverUrl: SERVER_URL, projectKey: 'my_project', path: '.' },
      });
    });

    it('defaults --path to the repository root when omitted', async () => {
      harness.withAuth(SERVER_URL, 'test-token');

      const result = await harness.run('link my_project');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
        project: { serverUrl: SERVER_URL, projectKey: 'my_project', path: '.' },
      });
    });

    it('writes a Cloud entry derived from a Cloud connection', async () => {
      harness.withAuth(SONARCLOUD_URL, 'test-token', 'my-org');
      harness.cwd.writeFile('services/api/.keep', '');

      const result = await harness.run('link my_project --path services/api');

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

    it.each([
      [`${SONARCLOUD_URL}/`, 'eu'],
      [`${SONARCLOUD_US_URL}/`, 'us'],
      [`${SONARCLOUD_URL.toUpperCase()}/`, 'eu'],
    ] as const)('keeps a region entry for production Cloud URL %s', async (serverUrl, region) => {
      harness.withAuth(serverUrl, 'test-token', 'my-org');

      const result = await harness.run('link my_project --path .');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
        project: { region, organization: 'my-org', projectKey: 'my_project', path: '.' },
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

      const result = await harness.run('link my_project --path .');

      expect(result.exitCode).toBe(0);
      const file = harness.cwd.file('.sonar-config.json').asJson() as {
        project: { projectKey: string };
      };
      expect(file.project.projectKey).toBe('my_project');
    });

    it.each(['https://sc-staging.io', `${SONARCLOUD_URL}:8443`])(
      'retains the Cloud URL %s in the shared configuration',
      async (serverUrl) => {
        harness.withAuth(serverUrl, 'test-token', 'my-org');

        const result = await harness.run('link my_project --path .');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
          project: { serverUrl, organization: 'my-org', projectKey: 'my_project', path: '.' },
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

  it('replaces an existing projects array without --monorepo, warning which mappings it removed', async () => {
    harness.withAuth(SERVER_URL, 'test-token');
    harness.cwd.writeFile('services/api/.keep', '');
    harness.cwd.writeFile(
      '.sonar-config.json',
      JSON.stringify({
        projects: [
          { serverUrl: SERVER_URL, projectKey: 'a', path: '.' },
          { serverUrl: SERVER_URL, projectKey: 'b', path: 'services/api' },
        ],
      }),
    );

    const result = await harness.run('link my_project --path .');

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain('Removed the other mappings');
    expect(result.stdout + result.stderr).toContain('(b)');
    expect(result.stdout).toContain('Linked ');
    expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
      project: { serverUrl: SERVER_URL, projectKey: 'my_project', path: '.' },
    });
  });

  describe('monorepo', () => {
    it('adds directories to the existing link, updates repeats in place, and writes a projects array', async () => {
      harness.withAuth(SERVER_URL, 'test-token');
      harness.cwd.writeFile('services/api/.keep', '');
      harness.cwd.writeFile('services/web/.keep', '');
      expect((await harness.run('link legacy --path .')).exitCode).toBe(0);
      expect((await harness.run('link api --monorepo --path services/api')).exitCode).toBe(0);
      expect((await harness.run('link web --monorepo --path services/web')).exitCode).toBe(0);

      const result = await harness.run('link api2 --monorepo --path ./services/api/');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('(monorepo mapping)');
      expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
        projects: [
          { serverUrl: SERVER_URL, projectKey: 'legacy', path: '.' },
          { serverUrl: SERVER_URL, projectKey: 'api2', path: 'services/api' },
          { serverUrl: SERVER_URL, projectKey: 'web', path: 'services/web' },
        ],
      });
    });

    it('does not overwrite a malformed configuration', async () => {
      harness.withAuth(SERVER_URL, 'test-token');
      harness.cwd.writeFile('.sonar-config.json', JSON.stringify({ projects: {} }));

      const result = await harness.run('link api --monorepo');

      expect(result.exitCode).not.toBe(0);
      expect(harness.cwd.file('.sonar-config.json').asText()).toBe(
        JSON.stringify({ projects: {} }),
      );
    });

    it('is documented in link --help', async () => {
      const result = await harness.run('link --help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--monorepo');
    });
  });

  describe('without a project key', () => {
    const TIMEOUT = 30_000;

    beforeEach(() => {
      initGitRepo(harness.cwd.path);
    });

    async function signInToServer(): Promise<string> {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('alpha')
        .withProject('beta')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: '1' });
      return server.baseUrl();
    }

    it(
      'fails with a hint to pass the key when the terminal cannot prompt',
      async () => {
        harness.withAuth(SERVER_URL, 'test-token');

        const result = await harness.run('link');

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout + result.stderr).toContain('sonar link <projectKey>');
        expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
      },
      TIMEOUT,
    );

    it(
      'proposes a project found in local config once the server confirms it exists',
      async () => {
        const serverUrl = await signInToServer();
        harness.cwd.writeFile(
          'sonar-project.properties',
          `sonar.projectKey=beta\nsonar.host.url=${serverUrl}\n`,
        );

        const session = harness.runInteractive('link');
        await session.accept('beta (beta)?');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`Linked ${harness.cwd.path} to project beta`);
        expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
          project: { serverUrl, projectKey: 'beta', path: '.' },
        });
      },
      TIMEOUT,
    );

    it(
      'falls back to the search list when the proposal is declined, then links the selection',
      async () => {
        const serverUrl = await signInToServer();
        harness.cwd.writeFile(
          'sonar-project.properties',
          `sonar.projectKey=beta\nsonar.host.url=${serverUrl}\n`,
        );

        const session = harness.runInteractive('link');
        await session.decline('beta (beta)?');
        await session.waitText('Choose a project');
        session.write('alpha');
        await session.waitText('1 match');
        session.keyEnter();
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
          project: { serverUrl, projectKey: 'alpha', path: '.' },
        });
      },
      TIMEOUT,
    );

    it(
      'opens the search list straight away when nothing is discovered',
      async () => {
        const serverUrl = await signInToServer();

        const session = harness.runInteractive('link');
        await session.waitText('Choose a project');
        await session.waitText('2 projects');
        session.keyEnter();
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
          project: { serverUrl, projectKey: 'alpha', path: '.' },
        });
      },
      TIMEOUT,
    );

    it(
      'fails when the user cancels the search prompt',
      async () => {
        await signInToServer();

        const session = harness.runInteractive('link');
        await session.waitText('Choose a project');
        session.keyCtrlC();
        const result = await session.waitFinish();

        expect(result.exitCode).not.toBe(0);
        expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
      },
      TIMEOUT,
    );

    describe('in a repository with folders', () => {
      beforeEach(() => {
        harness.cwd.writeFile('.gitignore', 'build/\n');
        harness.cwd.writeFile('build/output.txt', '');
        harness.cwd.writeFile('.hidden/notes.txt', '');
        harness.cwd.writeFile('services/api/package.json', '{}');
        harness.cwd.writeFile('web/package.json', '{}');
      });

      it(
        'lists the visible top-level folders, then links the one ticked folder as a single project',
        async () => {
          const serverUrl = await signInToServer();

          const session = harness.runInteractive('link');
          await session.waitText('Choose the project folders');
          await session.waitText('web');
          const folders = session.output();
          expect(folders).toContain('. (repository root)');
          expect(folders).toContain('services');
          expect(folders).not.toContain('build');
          expect(folders).not.toContain('.hidden');

          session.keyDown();
          session.keyDown();
          session.keyTab();
          await session.waitText('1 selected');
          session.keyEnter();
          await session.waitText('Choose a project');
          await session.waitText('2 projects');
          session.keyEnter();
          const result = await session.waitFinish();

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain(
            `Linked ${join(harness.cwd.path, 'web')} to project alpha`,
          );
          expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
            project: { serverUrl, projectKey: 'alpha', path: 'web' },
          });
        },
        TIMEOUT,
      );

      it(
        'expands a folder to link one nested inside it',
        async () => {
          const serverUrl = await signInToServer();

          const session = harness.runInteractive('link');
          await session.waitText('Choose the project folders');
          await session.waitText('web');
          session.keyDown();
          session.keyRight();
          await session.waitText('api');
          session.keyDown();
          session.keyTab();
          await session.waitText('1 selected');
          session.keyEnter();
          await session.waitText('Choose a project');
          await session.waitText('2 projects');
          session.keyEnter();
          const result = await session.waitFinish();

          expect(result.exitCode).toBe(0);
          expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
            project: { serverUrl, projectKey: 'alpha', path: 'services/api' },
          });
        },
        TIMEOUT,
      );

      it(
        'finds an empty folder, which git does not track, by name and links it',
        async () => {
          const serverUrl = await signInToServer();
          mkdirSync(join(harness.cwd.path, 'services', 'api', 'empty-test'));

          const session = harness.runInteractive('link');
          await session.waitText('Choose the project folders');
          session.write('test');
          await session.waitText('services/api/empty-test');
          await session.waitText('1 match');
          session.keyTab();
          await session.waitText('1 selected');
          session.keyEnter();
          await session.waitText('Choose a project');
          await session.waitText('2 projects');
          session.keyEnter();
          const result = await session.waitFinish();

          expect(result.exitCode).toBe(0);
          expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
            project: { serverUrl, projectKey: 'alpha', path: 'services/api/empty-test' },
          });
        },
        TIMEOUT,
      );

      it(
        'finds a nested folder by name without expanding the tree, leaving ignored ones out',
        async () => {
          const serverUrl = await signInToServer();

          const session = harness.runInteractive('link');
          await session.waitText('Choose the project folders');
          session.write('build');
          await session.waitText("No folders match 'build'.");
          session.write('\x7f\x7f\x7f\x7f\x7fapi');
          await session.waitText('1 match');
          session.keyTab();
          await session.waitText('1 selected');
          session.keyEnter();
          await session.waitText('Choose a project');
          await session.waitText('2 projects');
          session.keyEnter();
          const result = await session.waitFinish();

          expect(result.exitCode).toBe(0);
          expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
            project: { serverUrl, projectKey: 'alpha', path: 'services/api' },
          });
        },
        TIMEOUT,
      );

      it(
        'ticks search results with Tab, keeping them across searches, and types spaces',
        async () => {
          const serverUrl = await signInToServer();
          harness.cwd.writeFile('web/My App/package.json', '{}');

          const session = harness.runInteractive('link --monorepo');
          await session.waitText('Choose the project folders');
          session.write('api');
          await session.waitText('1 match');
          await session.waitText('Tab select');
          session.keyTab();
          await session.waitText('1 selected');
          session.write('\x7f\x7f\x7fmy app');
          await session.waitText('my app█');
          await session.waitText('web/My App');
          await session.waitText('1 match');
          session.keyTab();
          await session.waitText('2 selected');
          session.keyEnter();

          await session.waitText('Choosing the project for services/api');
          await session.waitText('2 projects');
          session.keyEnter();
          await session.waitText('Choosing the project for web/My App');
          await session.waitText('2 projects');
          session.keyDown();
          session.keyEnter();
          const result = await session.waitFinish();

          expect(result.exitCode).toBe(0);
          expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
            projects: [
              { serverUrl, projectKey: 'alpha', path: 'services/api' },
              { serverUrl, projectKey: 'beta', path: 'web/My App' },
            ],
          });
        },
        TIMEOUT,
      );

      it(
        'skips the folder picker when --path is given',
        async () => {
          const serverUrl = await signInToServer();

          const session = harness.runInteractive('link --path web');
          await session.waitText('2 projects');
          session.keyEnter();
          const result = await session.waitFinish();

          expect(result.exitCode).toBe(0);
          expect(result.stdout).not.toContain('Choose the project folder');
          expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
            project: { serverUrl, projectKey: 'alpha', path: 'web' },
          });
        },
        TIMEOUT,
      );

      it(
        'links each folder ticked at any depth in a monorepo to its own project',
        async () => {
          const serverUrl = await signInToServer();

          const session = harness.runInteractive('link --monorepo');
          await session.waitText('Choose the project folders');
          await session.waitText('web');
          session.keyEnter();
          await session.waitText('Select at least one with Tab.');
          session.keyDown();
          session.keyRight();
          await session.waitText('api');
          session.keyDown();
          session.keyTab();
          session.keyDown();
          session.keyTab();
          await session.waitText('2 selected');
          session.keyEnter();

          await session.waitText('Choosing the project for services/api');
          await session.waitText('2 projects');
          session.keyEnter();
          await session.waitText('Choosing the project for web');
          await session.waitText('2 projects');
          session.keyDown();
          session.keyEnter();
          const result = await session.waitFinish();

          expect(result.exitCode).toBe(0);
          expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
            projects: [
              { serverUrl, projectKey: 'alpha', path: 'services/api' },
              { serverUrl, projectKey: 'beta', path: 'web' },
            ],
          });
          expect(result.stdout).toContain(
            'Linked 2 folders (monorepo mappings):\n  services/api → alpha\n  web → beta',
          );
          expect(result.stdout.split('Config saved to')).toHaveLength(2);
        },
        TIMEOUT,
      );

      it(
        'saves none of the ticked folders when a later project prompt is cancelled',
        async () => {
          await signInToServer();

          const session = harness.runInteractive('link --monorepo');
          await session.waitText('Choose the project folders');
          await session.waitText('web');
          session.keyDown();
          session.keyTab();
          session.keyDown();
          session.keyTab();
          await session.waitText('2 selected');
          session.keyEnter();
          await session.waitText('Choosing the project for services');
          await session.waitText('2 projects');
          session.keyEnter();
          await session.waitText('Choosing the project for web');
          await session.waitText('2 projects');
          session.keyCtrlC();
          const result = await session.waitFinish();

          expect(result.exitCode).not.toBe(0);
          expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
        },
        TIMEOUT,
      );

      it(
        'fails without writing when the user cancels the monorepo folder picker',
        async () => {
          await signInToServer();

          const session = harness.runInteractive('link --monorepo');
          await session.waitText('Choose the project folders');
          session.keyCtrlC();
          const result = await session.waitFinish();

          expect(result.exitCode).not.toBe(0);
          expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
        },
        TIMEOUT,
      );

      it(
        'marks the folders that are linked, or hold linked folders deeper inside',
        async () => {
          const serverUrl = await signInToServer();
          harness.cwd.writeFile(
            '.sonar-config.json',
            JSON.stringify({
              projects: [
                { serverUrl, projectKey: 'web_project', path: 'web' },
                { serverUrl, projectKey: 'api_project', path: 'services/api' },
              ],
            }),
          );

          const session = harness.runInteractive('link');
          await session.waitText('2 projects deeper');
          await session.waitText('1 project deeper');
          await session.waitText('linked to web_project');
          session.keyDown();
          session.keyRight();
          await session.waitText('linked to api_project');
          session.keyCtrlC();
          const result = await session.waitFinish();

          // A linked folder does not count itself among the projects deeper inside it.
          expect(result.stdout).not.toContain('linked to web_project,');
          expect(result.stdout).not.toContain('linked to api_project,');
        },
        TIMEOUT,
      );

      it(
        'links the repository root when it is the folder ticked',
        async () => {
          const serverUrl = await signInToServer();

          const session = harness.runInteractive('link');
          await session.waitText('Choose the project folders');
          await session.waitText('web');
          session.keyTab();
          await session.waitText('1 selected');
          session.keyEnter();
          await session.waitText('Choose a project');
          await session.waitText('2 projects');
          session.keyEnter();
          const result = await session.waitFinish();

          expect(result.exitCode).toBe(0);
          expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
            project: { serverUrl, projectKey: 'alpha', path: '.' },
          });
        },
        TIMEOUT,
      );

      it(
        'adds a single ticked folder to the existing link, turning the file into a projects array',
        async () => {
          const serverUrl = await signInToServer();
          const web = { serverUrl, projectKey: 'beta', path: 'web' };
          harness.cwd.writeFile('.sonar-config.json', JSON.stringify({ project: web }));

          const session = harness.runInteractive('link');
          await session.waitText('linked to beta');
          session.keyTab();
          await session.waitText('1 selected');
          session.keyEnter();
          await session.waitText('Choose a project');
          await session.waitText('2 projects');
          session.keyEnter();
          const result = await session.waitFinish();

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain('(monorepo mapping)');
          expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual({
            projects: [web, { serverUrl, projectKey: 'alpha', path: '.' }],
          });
        },
        TIMEOUT,
      );

      it(
        'asks before relinking a ticked folder that is already linked, and keeps it on no',
        async () => {
          const serverUrl = await signInToServer();
          const config = { project: { serverUrl, projectKey: 'beta', path: 'web' } };
          harness.cwd.writeFile('.sonar-config.json', JSON.stringify(config));

          const session = harness.runInteractive('link');
          await session.waitText('linked to beta');
          session.keyDown();
          session.keyDown();
          session.keyTab();
          await session.waitText('1 selected');
          session.keyEnter();
          await session.waitText('is already linked to project beta');
          await session.decline('Link it to another project instead?');
          const result = await session.waitFinish();

          expect(result.exitCode).toBe(0);
          expect(harness.cwd.file('.sonar-config.json').asJson()).toEqual(config);
        },
        TIMEOUT,
      );

      it(
        'fails without writing when the user cancels the folder picker',
        async () => {
          await signInToServer();

          const session = harness.runInteractive('link');
          await session.waitText('Choose the project folders');
          session.keyCtrlC();
          const result = await session.waitFinish();

          expect(result.exitCode).not.toBe(0);
          expect(result.stdout + result.stderr).not.toContain('Choose a project');
          expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
        },
        TIMEOUT,
      );
    });
  });
});
