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

// Integration tests for `sonar context <action>` — the passthrough wrapper to
// the locally-installed sonar-context-augmentation binary.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { canonicalizePath } from '@/core/io/fs-utils.ts';

import { TestHarness } from '../../harness';
import {
  type CagInvocation,
  readCagInvocations as readInvocations,
} from '../../harness/cag-helpers';
import { commitFile, git, initGitRepo } from '../hook/git-test-helpers';

// CAG stub spawn + temp-dir teardown on Windows can exceed Bun's default hook timeout.
setDefaultTimeout(30_000);

function findInvocation(invocations: CagInvocation[], argv: string[]): CagInvocation {
  const matches = invocations.filter((i) => JSON.stringify(i.argv) === JSON.stringify(argv));
  expect(matches).toHaveLength(1);
  const [match] = matches;
  if (!match) {
    throw new Error(`Expected CAG invocation: ${JSON.stringify(argv)}`);
  }
  return match;
}

const ORG_KEY = 'expected-org';
const PROJECT_KEY = 'expected-project';
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('sonar context passthrough', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('keeps the context child exit code when it exits before reading its input', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), 'expected-token', ORG_KEY);
    harness.state().withContextAugmentationBinaryInstalled();

    const result = await harness.runWithStdin(
      'hook claude-post-tool-use-failure',
      'input'.repeat(1_000_000),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('EPIPE');
    expect(readInvocations(harness)).toHaveLength(1);
  });

  it.each([
    [
      'forwards args verbatim and injects Sonar context env from auth',
      'context get-source --file foo.ts --line 42',
      ['get-source', '--file', 'foo.ts', '--line', '42'],
    ],
    [
      'forwards <action> --help to CAG with Sonar context env injected',
      'context get-source --help',
      ['get-source', '--help'],
    ],
  ])(
    '%s',
    async (_title, command, expectedArgv) => {
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'expected-token', ORG_KEY);
      harness
        .state()
        .withContextAugmentationBinaryInstalled()
        .withContextAugmentationSkill(harness.cwd.path, PROJECT_KEY, ORG_KEY, serverUrl);

      const result = await harness.run(command);

      expect(result.exitCode).toBe(0);
      const invocations = readInvocations(harness);
      const invocation = findInvocation(invocations, expectedArgv);
      expect(invocation.env.SONAR_CONTEXT_TOKEN).toBe('expected-token');
      expect(invocation.env.SONAR_CONTEXT_URL).toBe(serverUrl);
      expect(invocation.env.SONAR_CONTEXT_ORGANIZATION).toBe(ORG_KEY);
      expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe(PROJECT_KEY);
      expect(invocation.env.SONAR_CONTEXT_INVOCATION_ID).toMatch(UUID_V4_RE);
    },
    { timeout: 30000 },
  );

  it(
    'prefers the recorded project CAG connection over the active org',
    async () => {
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'active-token', 'active-org');
      harness
        .state()
        .withKeychainToken(serverUrl, 'project-token', ORG_KEY)
        .withContextAugmentationBinaryInstalled()
        .withContextAugmentationSkill(harness.cwd.path, PROJECT_KEY, ORG_KEY, serverUrl);

      const result = await harness.run('context status');

      expect(result.exitCode).toBe(0);
      const invocation = findInvocation(readInvocations(harness), ['status']);
      expect(invocation.env.SONAR_CONTEXT_TOKEN).toBe('project-token');
      expect(invocation.env.SONAR_CONTEXT_URL).toBe(serverUrl);
      expect(invocation.env.SONAR_CONTEXT_ORGANIZATION).toBe(ORG_KEY);
      expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe(PROJECT_KEY);
    },
    { timeout: 30000 },
  );

  it.each([
    ['the active token', ORG_KEY, 'active-token'],
    ['a stored token for another org', 'active-org', 'project-token'],
  ])(
    'accepts an equivalent recorded server URL with %s',
    async (_source, activeOrg, expectedToken) => {
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      const recordedUrl = `${serverUrl}/`;
      harness.withAuth(serverUrl, 'active-token', activeOrg);
      if (activeOrg !== ORG_KEY) {
        harness.state().withKeychainToken(serverUrl, 'project-token', ORG_KEY);
      }
      harness
        .state()
        .withContextAugmentationBinaryInstalled()
        .withContextAugmentationSkill(harness.cwd.path, PROJECT_KEY, ORG_KEY, recordedUrl);

      const result = await harness.run('context status');

      expect(result.exitCode).toBe(0);
      const invocation = findInvocation(readInvocations(harness), ['status']);
      expect(invocation.env.SONAR_CONTEXT_TOKEN).toBe(expectedToken);
      expect(invocation.env.SONAR_CONTEXT_URL).toBe(recordedUrl);
    },
    { timeout: 30000 },
  );

  it(
    'resolves the recorded project CAG connection from inside a linked git worktree',
    async () => {
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'project-token', ORG_KEY);
      // Record the CAG feature against the main checkout, as `sonar integrate` would.
      harness
        .state()
        .withContextAugmentationBinaryInstalled()
        .withContextAugmentationSkill(harness.cwd.path, PROJECT_KEY, ORG_KEY, serverUrl);

      // Make the main checkout a git repo and add a linked worktree beside it.
      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'README.md', '# test\n');
      const worktreePath = join(dirname(harness.cwd.path), 'linked-worktree');
      git(['worktree', 'add', worktreePath, '-b', 'feature/x'], harness.cwd.path);

      // Run from the worktree, whose path never matches the recorded targetRoot.
      const result = await harness.run('context status', { cwd: worktreePath });

      expect(result.exitCode).toBe(0);
      const invocation = findInvocation(readInvocations(harness), ['status']);
      expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe(PROJECT_KEY);
      expect(invocation.env.SONAR_CONTEXT_ORGANIZATION).toBe(ORG_KEY);
      expect(invocation.env.SONAR_CONTEXT_URL).toBe(serverUrl);
      expect(invocation.env.SONAR_CONTEXT_TOKEN).toBe('project-token');
      // Workspace dir is the invocation worktree, not the main checkout where state is keyed.
      expect(invocation.env.SONAR_CONTEXT_WORKSPACE_ROOT).toBe(canonicalizePath(worktreePath));
    },
    { timeout: 30000 },
  );

  it(
    'sets SONAR_CONTEXT_WORKSPACE_ROOT to the integrated folder from a subdirectory of a non-git project',
    async () => {
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'project-token', ORG_KEY);
      // Integrated at the project root; no git repo is initialised here.
      harness
        .state()
        .withContextAugmentationBinaryInstalled()
        .withContextAugmentationSkill(harness.cwd.path, PROJECT_KEY, ORG_KEY, serverUrl);

      const subdir = join(harness.cwd.path, 'packages', 'app');
      mkdirSync(subdir, { recursive: true });

      const result = await harness.run('context status', { cwd: subdir });

      expect(result.exitCode).toBe(0);
      const invocation = findInvocation(readInvocations(harness), ['status']);
      expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe(PROJECT_KEY);
      expect(invocation.env.SONAR_CONTEXT_WORKSPACE_ROOT).toBe(canonicalizePath(harness.cwd.path));
    },
    { timeout: 30000 },
  );

  it(
    'sets SONAR_CONTEXT_WORKSPACE_ROOT to the worktree root from a subdirectory of a linked git worktree',
    async () => {
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'project-token', ORG_KEY);
      harness
        .state()
        .withContextAugmentationBinaryInstalled()
        .withContextAugmentationSkill(harness.cwd.path, PROJECT_KEY, ORG_KEY, serverUrl);

      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'README.md', '# test\n');
      const worktreePath = join(dirname(harness.cwd.path), 'linked-worktree');
      git(['worktree', 'add', worktreePath, '-b', 'feature/subdir'], harness.cwd.path);
      const subdir = join(worktreePath, 'packages', 'app');
      mkdirSync(subdir, { recursive: true });

      const result = await harness.run('context status', { cwd: subdir });

      expect(result.exitCode).toBe(0);
      const invocation = findInvocation(readInvocations(harness), ['status']);
      expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe(PROJECT_KEY);
      expect(invocation.env.SONAR_CONTEXT_WORKSPACE_ROOT).toBe(canonicalizePath(worktreePath));
    },
    { timeout: 30000 },
  );

  it(
    'resolves context from a recorded known-server-project mapping',
    async () => {
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      harness
        .state()
        .withAuth(serverUrl, 'project-token', ORG_KEY)
        .withContextAugmentationBinaryInstalled()
        .withKnownServerProjectMapping(harness.cwd.path, PROJECT_KEY, serverUrl, ORG_KEY);

      const result = await harness.run('context status');

      expect(result.exitCode).toBe(0);
      const invocation = findInvocation(readInvocations(harness), ['status']);
      expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe(PROJECT_KEY);
      expect(invocation.env.SONAR_CONTEXT_ORGANIZATION).toBe(ORG_KEY);
      expect(invocation.env.SONAR_CONTEXT_URL).toBe(serverUrl);
      expect(invocation.env.SONAR_CONTEXT_TOKEN).toBe('project-token');
    },
    { timeout: 30000 },
  );

  it(
    'resolves a mapping via its repoRoot signal when invoked from a linked worktree',
    async () => {
      // The mapping's targetRoot points at a different (unrelated) physical location,
      // so this can only resolve through the repoRoot fallback signal — proving the two
      // stay distinct instead of collapsing into a single "folder".
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'README.md', '# test\n');
      const worktreePath = join(dirname(harness.cwd.path), 'linked-worktree');
      git(['worktree', 'add', worktreePath, '-b', 'feature/repo-root-fallback'], harness.cwd.path);

      harness
        .state()
        .withAuth(serverUrl, 'main-token', ORG_KEY)
        .withContextAugmentationBinaryInstalled()
        .withKnownServerProjectMapping(
          join(dirname(harness.cwd.path), 'other-physical-location'),
          PROJECT_KEY,
          serverUrl,
          ORG_KEY,
          harness.cwd.path,
        );

      const result = await harness.run('context status', { cwd: worktreePath });

      expect(result.exitCode).toBe(0);
      const invocation = findInvocation(readInvocations(harness), ['status']);
      expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe(PROJECT_KEY);
      expect(invocation.env.SONAR_CONTEXT_ORGANIZATION).toBe(ORG_KEY);
      expect(invocation.env.SONAR_CONTEXT_URL).toBe(serverUrl);
    },
    { timeout: 30000 },
  );

  it(
    'uses the first recorded mapping when multiple entries with different project keys share the same project root',
    async () => {
      // A genuine conflict (same folder, disagreeing projects), not a duplicate — resolved
      // deterministically by keeping whichever was recorded first, not by recency.
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      harness
        .state()
        .withAuth(serverUrl, 'first-token', 'first-org')
        .withContextAugmentationBinaryInstalled()
        .withKnownServerProjectMapping(harness.cwd.path, 'first-project', serverUrl, 'first-org')
        .withKnownServerProjectMapping(harness.cwd.path, 'second-project', serverUrl, 'second-org');

      const result = await harness.run('context status');

      expect(result.exitCode).toBe(0);
      const invocation = findInvocation(readInvocations(harness), ['status']);
      expect(invocation.env.SONAR_CONTEXT_TOKEN).toBe('first-token');
      expect(invocation.env.SONAR_CONTEXT_URL).toBe(serverUrl);
      expect(invocation.env.SONAR_CONTEXT_ORGANIZATION).toBe('first-org');
      expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe('first-project');
    },
    { timeout: 30000 },
  );

  it(
    'fails when the recorded project CAG connection has no token',
    async () => {
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'active-token', 'active-org');
      harness
        .state()
        .withContextAugmentationBinaryInstalled()
        .withContextAugmentationSkill(harness.cwd.path, PROJECT_KEY, ORG_KEY, serverUrl);

      const result = await harness.run('context status');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('recorded Vortex Context connection');
      expect(readInvocations(harness).some((i) => i.argv[0] === 'status')).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'does not fall back to the active token when the recorded CAG URL has no token',
    async () => {
      const activeServer = await harness.newFakeServer().start();
      const recordedServer = await harness.newFakeServer().start();
      const recordedServerUrl = recordedServer.baseUrl();
      harness.withAuth(activeServer.baseUrl(), 'active-token', 'active-org');
      harness
        .state()
        .withContextAugmentationBinaryInstalled()
        .withContextAugmentationSkill(harness.cwd.path, PROJECT_KEY, ORG_KEY, recordedServerUrl);

      const result = await harness.run('context status');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        `Not authenticated for the recorded Vortex Context connection: ${recordedServerUrl} (${ORG_KEY}).`,
      );
      expect(result.stderr).toContain(`sonar auth login --server ${recordedServerUrl}`);
      expect(readInvocations(harness).some((i) => i.argv[0] === 'status')).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'directs environment-authenticated users to match the recorded server before logging in',
    async () => {
      const activeServer = await harness.newFakeServer().start();
      const recordedServer = await harness.newFakeServer().start();
      const recordedServerUrl = recordedServer.baseUrl();
      harness
        .state()
        .withContextAugmentationBinaryInstalled()
        .withContextAugmentationSkill(harness.cwd.path, PROJECT_KEY, ORG_KEY, recordedServerUrl);

      const result = await harness.run('context status', {
        extraEnv: {
          SONARQUBE_CLI_TOKEN: 'environment-token',
          SONARQUBE_CLI_SERVER: activeServer.baseUrl(),
          SONARQUBE_CLI_ORG: 'active-org',
        },
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`SONARQUBE_CLI_SERVER=${recordedServerUrl}`);
      expect(result.stderr).toContain(`SONARQUBE_CLI_ORG=${ORG_KEY}`);
      expect(result.stderr).toContain('with a matching SONARQUBE_CLI_TOKEN');
      expect(result.stderr).toContain('unset SONARQUBE_CLI_TOKEN');
      expect(readInvocations(harness).some((invocation) => invocation.argv[0] === 'status')).toBe(
        false,
      );
    },
    { timeout: 30000 },
  );

  it(
    'does not read a stored token for a recorded URL that differs from the active connection',
    async () => {
      const activeServer = await harness.newFakeServer().start();
      const recordedServer = await harness.newFakeServer().start();
      const recordedServerUrl = recordedServer.baseUrl();
      harness.withAuth(activeServer.baseUrl(), 'active-token', ORG_KEY);
      harness
        .state()
        .withKeychainToken(recordedServerUrl, 'stored-token', ORG_KEY)
        .withContextAugmentationBinaryInstalled()
        .withContextAugmentationSkill(harness.cwd.path, PROJECT_KEY, ORG_KEY, recordedServerUrl);

      const result = await harness.run('context status');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        'Not authenticated for the recorded Vortex Context connection',
      );
      expect(readInvocations(harness).some((invocation) => invocation.argv[0] === 'status')).toBe(
        false,
      );
    },
    { timeout: 30000 },
  );

  it(
    'does not inherit caller SONAR_CONTEXT_PROJECT when no recorded CAG feature matches the cwd',
    async () => {
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'auth-token', 'auth-org');
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run('context status', {
        extraEnv: {
          SONAR_CONTEXT_ORGANIZATION: 'caller-org',
          SONAR_CONTEXT_PROJECT: 'caller-project',
          SONAR_CONTEXT_TOKEN: 'caller-token',
          SONAR_CONTEXT_URL: 'https://caller.example',
          SONAR_CONTEXT_WORKSPACE_ROOT: '/caller/workspace',
        },
      });

      expect(result.exitCode).toBe(0);
      const invocation = findInvocation(readInvocations(harness), ['status']);
      expect(invocation.env.SONAR_CONTEXT_TOKEN).toBe('auth-token');
      expect(invocation.env.SONAR_CONTEXT_URL).toBe(serverUrl);
      expect(invocation.env.SONAR_CONTEXT_ORGANIZATION).toBe('auth-org');
      expect(invocation.env.SONAR_CONTEXT_PROJECT).toBeUndefined();
      // No recorded integration matched → workspace dir is not set, and a stray
      // caller-provided value is not inherited.
      expect(invocation.env.SONAR_CONTEXT_WORKSPACE_ROOT).toBeUndefined();
      expect(invocation.env.SONAR_CONTEXT_INVOCATION_ID).toMatch(UUID_V4_RE);
    },
    { timeout: 30000 },
  );

  it(
    'fails with a helpful message when the CAG binary is not installed',
    async () => {
      const server = await harness.newFakeServer().start();
      harness.withAuth(server.baseUrl(), 'tok');

      const result = await harness.run('context status');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain('not installed');
      expect(result.stderr).toContain('sonar integrate');
    },
    { timeout: 30000 },
  );

  it(
    'requires authentication',
    async () => {
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run('context status');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain('not authenticated');
    },
    { timeout: 30000 },
  );

  it.each([
    ['forwards --help to CAG without requiring authentication', 'context --help', ['--help']],
    ['forwards -h to CAG without requiring authentication', 'context -h', ['-h']],
    ['forwards --help to CAG when no action is given (bare sonar context)', 'context', ['--help']],
  ])(
    '%s',
    async (_title, command, expectedArgv) => {
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run(command, {
        extraEnv: {
          SONAR_CONTEXT_ORGANIZATION: 'caller-org',
          SONAR_CONTEXT_PROJECT: 'caller-project',
          SONAR_CONTEXT_TOKEN: 'caller-token',
          SONAR_CONTEXT_URL: 'https://caller.example',
        },
      });

      expect(result.exitCode).toBe(0);
      const invocations = readInvocations(harness);
      expect(invocations).toHaveLength(1);
      expect(invocations[0].argv).toEqual(expectedArgv);
      expect(invocations[0].env.SONAR_CONTEXT_TOKEN).toBe('caller-token');
      expect(invocations[0].env.SONAR_CONTEXT_URL).toBe('https://caller.example');
      expect(invocations[0].env.SONAR_CONTEXT_ORGANIZATION).toBe('caller-org');
      expect(invocations[0].env.SONAR_CONTEXT_PROJECT).toBe('caller-project');
      expect(invocations[0].env.SONAR_CONTEXT_INVOCATION_ID).toMatch(UUID_V4_RE);
    },
    { timeout: 30000 },
  );

  describe('in a multi-project workspace', () => {
    let serverUrl: string;

    beforeEach(async () => {
      serverUrl = (await harness.newFakeServer().start()).baseUrl();
      harness.withAuth(serverUrl, 'expected-token', ORG_KEY);
      initGitRepo(harness.cwd.path);
      harness.state().withContextAugmentationBinaryInstalled();
      for (const path of ['services/api', 'services/api/v2', 'apps/web']) {
        harness.cwd.writeFile(`${path}/.keep`, '');
      }
      harness.cwd.writeFile(
        '.sonar-config.json',
        JSON.stringify({
          projects: [
            { projectKey: 'api', path: 'services/api', serverUrl },
            { projectKey: 'api-v2', path: 'services/api/v2', serverUrl },
            { projectKey: 'web', path: 'apps/web', serverUrl },
          ],
        }),
      );
    });

    it('fails without invoking CAG and points at sonar link list', async () => {
      const result = await harness.run('context compass get');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `Could not determine a single SonarQube project for ${harness.cwd.path}.`,
      );
      expect(result.stderr).toContain(`3 projects are linked at or under ${harness.cwd.path}.`);
      expect(result.stderr).toContain('sonar link list --path <path>');
      expect(readInvocations(harness)).toEqual([]);
    });

    it('explains that nested project directories are not supported', async () => {
      const result = await harness.run('context compass get', {
        cwd: join(harness.cwd.path, 'services', 'api', 'v2'),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('is inside 2 nested projects, which are not supported yet.');
    });

    it('fails without invoking CAG outside every linked project', async () => {
      harness.cwd.writeFile('scripts/.keep', '');

      const result = await harness.run('context compass get', {
        cwd: join(harness.cwd.path, 'scripts'),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('is not inside any project linked in .sonar-config.json.');
      expect(result.stderr).toContain(`sonar link list --path "${harness.cwd.path}"`);
      expect(readInvocations(harness)).toEqual([]);
    });

    it('forwards a command run from inside one project with that project', async () => {
      const webRoot = join(harness.cwd.path, 'apps', 'web');

      const result = await harness.run('context compass get', { cwd: webRoot });

      expect(result.exitCode).toBe(0);
      const invocation = findInvocation(readInvocations(harness), ['compass', 'get']);
      expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe('web');
      expect(invocation.env.SONAR_CONTEXT_WORKSPACE_ROOT).toBe(webRoot);
    });

    it.each([['tool status'], ['__hook Claude']])(
      'still forwards "%s", which needs no project',
      async (command) => {
        const result = await harness.run(`context ${command}`);

        expect(result.exitCode).toBe(0);
        const invocation = findInvocation(readInvocations(harness), command.split(' '));
        expect(invocation.env.SONAR_CONTEXT_PROJECT).toBeUndefined();
      },
    );
  });

  it(
    'fails with a helpful message when CAG is not installed and --help is requested',
    async () => {
      const result = await harness.run('context --help');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain('not installed');
      expect(result.stderr).toContain('sonar integrate');
    },
    { timeout: 30000 },
  );
});
