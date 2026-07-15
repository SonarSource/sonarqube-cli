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

import { CONTEXT_AUGMENTATION_FEATURE_ID } from '../../../../src/cli/commands/integrate/_common/features/context-augmentation-feature';
import { CLAUDE_INTEGRATION_ID } from '../../../../src/cli/commands/integrate/claude/declaration';
import { COPILOT_INTEGRATION_ID } from '../../../../src/cli/commands/integrate/copilot/declaration';
import { canonicalizePath } from '../../../../src/lib/fs-utils';
import type { CliState, InstalledIntegrationFeature } from '../../../../src/lib/state.js';
import { TestHarness } from '../../harness';
import {
  type CagInvocation,
  readCagInvocations as readInvocations,
} from '../../harness/cag-invocations';
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

function appendRecordedCagFeature(
  state: CliState,
  args: {
    integrationId: string;
    targetRoot: string;
    updatedAt: string;
    projectKey: string;
    orgKey: string;
    serverUrl: string;
    repoRoot?: string;
  },
): void {
  let integration = state.integrations.installed.find(
    (entry) => entry.integrationId === args.integrationId,
  );
  if (!integration) {
    integration = {
      id: `${args.integrationId}-integration`,
      integrationId: args.integrationId,
      installedByCliVersion: 'integration-test',
      installedAt: args.updatedAt,
      updatedByCliVersion: 'integration-test',
      updatedAt: args.updatedAt,
      features: [],
    };
    state.integrations.installed.push(integration);
  }

  const feature: InstalledIntegrationFeature = {
    featureId: CONTEXT_AUGMENTATION_FEATURE_ID,
    scope: 'project',
    targetRoot: args.targetRoot,
    installedByCliVersion: 'integration-test',
    installedAt: args.updatedAt,
    updatedByCliVersion: 'integration-test',
    updatedAt: args.updatedAt,
    dependencies: [],
    resources: [],
    operations: [],
    attrs: {
      orgKey: args.orgKey,
      projectKey: args.projectKey,
      scaEnabled: false,
      serverUrl: args.serverUrl,
      ...(args.repoRoot ? { repoRoot: args.repoRoot } : {}),
    },
  };
  integration.features.push(feature);
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
    'matches on the recorded repoRoot when targetRoot points at a different worktree',
    async () => {
      // Simulates integrate having run inside worktree-A (targetRoot = that worktree),
      // while repoRoot records the stable main working tree. Running from the main
      // tree must still resolve via repoRoot even though cwd is not inside targetRoot.
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      const stateBuilder = harness
        .state()
        .withAuth(serverUrl, 'main-token', ORG_KEY)
        .withContextAugmentationBinaryInstalled();
      const state = stateBuilder.build();
      appendRecordedCagFeature(state, {
        integrationId: CLAUDE_INTEGRATION_ID,
        targetRoot: join(dirname(harness.cwd.path), 'some-other-worktree'),
        repoRoot: harness.cwd.path,
        updatedAt: '2026-03-01T00:00:00.000Z',
        projectKey: PROJECT_KEY,
        orgKey: ORG_KEY,
        serverUrl,
      });
      stateBuilder.withRawState(JSON.stringify(state, null, 2));

      const result = await harness.run('context status');

      expect(result.exitCode).toBe(0);
      const invocation = findInvocation(readInvocations(harness), ['status']);
      expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe(PROJECT_KEY);
      expect(invocation.env.SONAR_CONTEXT_ORGANIZATION).toBe(ORG_KEY);
      expect(invocation.env.SONAR_CONTEXT_URL).toBe(serverUrl);
    },
    { timeout: 30000 },
  );

  it(
    'prefers a targetRoot match over a more recent repoRoot-only match',
    async () => {
      // Two worktrees integrated with different project keys, both recording the
      // same main working tree as repoRoot. Running from the main tree, the
      // feature whose targetRoot IS the main tree must win over a sibling that
      // only shares the repoRoot — even though the sibling was updated later, so
      // recency alone would pick the wrong one.
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      const stateBuilder = harness
        .state()
        .withAuth(serverUrl, 'main-token', ORG_KEY)
        .withContextAugmentationBinaryInstalled();
      const state = stateBuilder.build();
      // repoRoot-only match, integrated in a sibling worktree, updated LATER.
      appendRecordedCagFeature(state, {
        integrationId: CLAUDE_INTEGRATION_ID,
        targetRoot: join(dirname(harness.cwd.path), 'some-other-worktree'),
        repoRoot: harness.cwd.path,
        updatedAt: '2026-02-01T00:00:00.000Z',
        projectKey: 'wrong-worktree-project',
        orgKey: ORG_KEY,
        serverUrl,
      });
      // Exact targetRoot match for the current directory, updated EARLIER.
      appendRecordedCagFeature(state, {
        integrationId: COPILOT_INTEGRATION_ID,
        targetRoot: harness.cwd.path,
        repoRoot: harness.cwd.path,
        updatedAt: '2026-01-01T00:00:00.000Z',
        projectKey: 'right-here-project',
        orgKey: ORG_KEY,
        serverUrl,
      });
      stateBuilder.withRawState(JSON.stringify(state, null, 2));

      const result = await harness.run('context status');

      expect(result.exitCode).toBe(0);
      const invocation = findInvocation(readInvocations(harness), ['status']);
      expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe('right-here-project');
    },
    { timeout: 30000 },
  );

  it(
    'uses the latest recorded CAG feature when multiple entries share the same project root',
    async () => {
      const server = await harness.newFakeServer().start();
      const serverUrl = server.baseUrl();
      const stateBuilder = harness
        .state()
        .withAuth(serverUrl, 'current-token', 'current-org')
        .withContextAugmentationBinaryInstalled();
      const state = stateBuilder.build();
      appendRecordedCagFeature(state, {
        integrationId: CLAUDE_INTEGRATION_ID,
        targetRoot: harness.cwd.path,
        updatedAt: '2026-01-01T00:00:00.000Z',
        projectKey: 'stale-project',
        orgKey: 'stale-org',
        serverUrl,
      });
      appendRecordedCagFeature(state, {
        integrationId: COPILOT_INTEGRATION_ID,
        targetRoot: harness.cwd.path,
        updatedAt: '2026-02-01T00:00:00.000Z',
        projectKey: 'current-project',
        orgKey: 'current-org',
        serverUrl,
      });
      stateBuilder.withRawState(JSON.stringify(state, null, 2));

      const result = await harness.run('context status');

      expect(result.exitCode).toBe(0);
      const invocation = findInvocation(readInvocations(harness), ['status']);
      expect(invocation.env.SONAR_CONTEXT_TOKEN).toBe('current-token');
      expect(invocation.env.SONAR_CONTEXT_URL).toBe(serverUrl);
      expect(invocation.env.SONAR_CONTEXT_ORGANIZATION).toBe('current-org');
      expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe('current-project');
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
      expect(result.stderr).toContain('recorded Vortex context augmentation connection');
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
        `Not authenticated for the recorded Vortex context augmentation connection: ${recordedServerUrl} (${ORG_KEY}).`,
      );
      expect(result.stderr).toContain('sonar auth login');
      expect(readInvocations(harness).some((i) => i.argv[0] === 'status')).toBe(false);
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
