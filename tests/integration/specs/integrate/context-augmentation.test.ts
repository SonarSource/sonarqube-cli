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

// Integration tests for the Context Augmentation step inside `sonar integrate
// claude`, `sonar integrate copilot`, and `sonar integrate codex`.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CONTEXT_AUGMENTATION_FEATURE_ID } from '@/commands/integrate/_common/features/context-augmentation-feature.js';
import {
  VORTEX_FEATURE_ID,
  VORTEX_PROMOTION_MESSAGE,
} from '@/commands/integrate/_common/vortex.js';
import { CLAUDE_INTEGRATION_ID } from '@/commands/integrate/claude/declaration.js';
import { CODEX_INTEGRATION_ID } from '@/commands/integrate/codex/declaration.js';
import { COPILOT_INTEGRATION_ID } from '@/commands/integrate/copilot/declaration.js';
import { CURSOR_INTEGRATION_ID } from '@/commands/integrate/cursor/declaration.js';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalCagBinaryName } from '@/core/host/install/context-augmentation.js';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '@/core/host/install/signatures.ts';
import { pathComparisonKey } from '@/core/io/fs-utils.ts';
import type { CliState, InstalledIntegrationFeature } from '@/core/state/state.ts';

import { TestHarness } from '../../harness';
import {
  expectVortexHookAbsent,
  expectVortexHookInstalled,
  readCagInvocations as readInvocations,
} from '../../harness/cag-helpers';
import { commitFile, git, initGitRepo } from '../hook/git-test-helpers';

function loadState(harness: TestHarness): CliState {
  return harness.stateJsonFile.asJson() as CliState;
}

interface RecordedCagFeature {
  integrationId: string;
  feature: InstalledIntegrationFeature;
}

function providesContextAugmentation(feature: InstalledIntegrationFeature): boolean {
  return (
    feature.featureId === CONTEXT_AUGMENTATION_FEATURE_ID ||
    (feature.featureId === VORTEX_FEATURE_ID &&
      (feature.subfeatures ?? []).some(
        (subfeature) => subfeature.featureId === CONTEXT_AUGMENTATION_FEATURE_ID,
      ))
  );
}

function findRecordedCagFeature(
  state: CliState,
  integrationId?: string,
): RecordedCagFeature | undefined {
  for (const integration of state.integrations.installed) {
    if (integrationId && integration.integrationId !== integrationId) {
      continue;
    }
    for (const feature of integration.features) {
      if (!providesContextAugmentation(feature)) {
        continue;
      }
      return {
        integrationId: integration.integrationId,
        feature,
      };
    }
  }
  return undefined;
}

function expectRecordedCagFeature(
  state: CliState,
  args: {
    integrationId: string;
    targetRoot: string;
    scaEnabled: boolean;
    serverUrl: string;
  },
): void {
  const entry = findRecordedCagFeature(state, args.integrationId);
  expect(entry).toBeDefined();
  if (!entry) {
    return;
  }
  expect(entry.integrationId).toBe(args.integrationId);
  expect(entry.feature.scope).toBe('global');
  expect(entry.feature.targetRoot).toBe(args.targetRoot);
  expect(entry.feature.attrs).toMatchObject({
    orgKey: ORG_KEY,
    projectKey: PROJECT_KEY,
    scaEnabled: args.scaEnabled,
    serverUrl: args.serverUrl,
  });
}

const PROJECT_KEY = 'my-project';
const ORG_KEY = 'my-org';
const ORG_UUID = `${ORG_KEY}-uuid-v4`;
const TOKEN = 'cloud-token';

describe('integrate claude — Context Augmentation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    await harness.newFakeBinariesServer().start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'installs the CAG session-start hook globally when project key + org are present',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .withScaEnabled(true)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      // A global install never binds the binary to one project via `tool integrate` —
      // the hook resolves the project at runtime instead.
      const invoked = readInvocations(harness).filter((i) => i.argv[1] === 'integrate');
      expect(invoked).toEqual([]);
      expectVortexHookInstalled(harness.userHome, 'claude', 'global');
      expectVortexHookAbsent(harness.cwd, 'claude');

      // State records the declarative feature.
      const state = loadState(harness);
      expectRecordedCagFeature(state, {
        integrationId: CLAUDE_INTEGRATION_ID,
        targetRoot: harness.userHome.path,
        scaEnabled: true,
        serverUrl,
      });
    },
    { timeout: 30000 },
  );

  it(
    'keys CAG state on the main working tree when integrate runs inside a linked worktree',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .withScaEnabled(true)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();

      // Main checkout = harness.cwd; add a linked worktree beside it and run
      // integrate from there.
      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'README.md', '# test\n');
      const worktreePath = join(dirname(harness.cwd.path), 'linked-worktree');
      git(['worktree', 'add', worktreePath, '-b', 'feature/x'], harness.cwd.path);
      writeFileSync(
        join(worktreePath, 'sonar-project.properties'),
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const integrateResult = await harness.run('integrate claude --non-interactive', {
        cwd: worktreePath,
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });
      expect(integrateResult.exitCode).toBe(0);

      // targetRoot is the global root regardless of worktree; repoRoot records the
      // stable main working tree, which is the key `sonar context` matches against
      // from any worktree. (The read side is covered deterministically in the
      // context passthrough spec — the harness re-applies its state builder on
      // every run, so an integrate-then-context flow in one test cannot share
      // state here.)
      const entry = findRecordedCagFeature(loadState(harness), CLAUDE_INTEGRATION_ID);
      expect(entry).toBeDefined();
      const targetRoot = entry?.feature.targetRoot ?? '';
      const repoRoot = entry?.feature.attrs?.repoRoot;
      expect(typeof repoRoot).toBe('string');
      // Compare full canonical paths (not just basenames): repoRoot resolves to
      // the main working tree even though integrate ran from the linked worktree.
      expect(pathComparisonKey(targetRoot)).toBe(pathComparisonKey(harness.userHome.path));
      expect(pathComparisonKey(repoRoot as string)).toBe(pathComparisonKey(harness.cwd.path));
      expect(repoRoot).not.toBe(targetRoot);
    },
    { timeout: 30000 },
  );

  it(
    'records scaEnabled=false and warns when the SCA enablement check fails',
    async () => {
      // No .withScaEnabled() call → fake server returns 404 for the SCA endpoint.
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Could not verify SCA availability');
      expectVortexHookInstalled(harness.userHome, 'claude', 'global');
      const state = loadState(harness);
      expectRecordedCagFeature(state, {
        integrationId: CLAUDE_INTEGRATION_ID,
        targetRoot: harness.userHome.path,
        scaEnabled: false,
        serverUrl,
      });
    },
    { timeout: 30000 },
  );

  it(
    'deletes the skill file left by a pre-hook CLI',
    async () => {
      const legacySkillPath = ['.claude', 'skills', 'sonar-context-augmentation', 'SKILL.md'];
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .withScaEnabled(true)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      // The container's legacyCleanups run against the actual install target,
      // which is the global root now that every agent install is global.
      harness.userHome.writeFile(join(...legacySkillPath), '# stale skill\n');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(harness.userHome.exists(...legacySkillPath)).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'fails the install and records nothing when the hook config file holds invalid JSON',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .withScaEnabled(true)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.userHome.writeFile('.claude/settings.json', '{ not json');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('contains invalid JSON');
      expectVortexHookAbsent(harness.userHome, 'claude', 'global');
      expect(findRecordedCagFeature(loadState(harness))).toBeUndefined();
    },
    { timeout: 30000 },
  );

  it(
    'skips CAG entirely when __SQCLI_DEV_SKIP_CAG is set',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .start();
      harness.withAuth(server.baseUrl(), TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${server.baseUrl()}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: { __SQCLI_DEV_SKIP_CAG: '1' },
      });

      expect(result.exitCode).toBe(0);
      // No init/skill invocations — only --version probes (if any) are allowed
      const invocations = readInvocations(harness);
      const nonProbe = invocations.filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      expectVortexHookAbsent(harness.cwd, 'claude');
      const state = loadState(harness);
      expect(findRecordedCagFeature(state)).toBeUndefined();
    },
    { timeout: 30000 },
  );

  it(
    'skips CAG with a warning when the org is not allowed to use it',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID, { allowed: false })
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const nonProbe = readInvocations(harness).filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      const state = loadState(harness);
      expect(findRecordedCagFeature(state)).toBeUndefined();
      expectVortexHookAbsent(harness.cwd, 'claude');
      expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_PROMOTION_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'installs CAG when the org is entitled but consumption limit is reached',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID, { allowed: false, hasEntitlement: true })
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('Vortex usage limit has been reached');
      const state = loadState(harness);
      expect(findRecordedCagFeature(state)).toBeDefined();
      expectVortexHookInstalled(harness.userHome, 'claude', 'global');
    },
    { timeout: 30000 },
  );

  it(
    'skips CAG with a warning when the entitlement check fails',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withCagEntitlementStatusCode(500)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const nonProbe = readInvocations(harness).filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      const state = loadState(harness);
      expect(findRecordedCagFeature(state)).toBeUndefined();
      expectVortexHookAbsent(harness.cwd, 'claude');
      expect(result.stderr).toContain('Could not determine Vortex entitlement');
    },
    { timeout: 30000 },
  );

  it(
    'downloads, verifies, and extracts CAG when the binary is absent',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      // No withContextAugmentationBinaryInstalled() — let the install pipeline run.
      await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      // The versioned binary must be on disk under <cliHome>/bin.
      const versionedName = buildLocalCagBinaryName(detectPlatform());
      expect(harness.cliHome.file('bin', versionedName).exists()).toBe(true);

      // state.json records the installed dependency even when the subsequent
      // feature setup fails.
      const state = loadState(harness);
      const installed = state.dependencies.installed.find(
        (d) => d.id === 'sonar-context-augmentation',
      );
      expect(installed).toBeDefined();
      expect(installed?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);
    },
    { timeout: 60000 },
  );

  it(
    'suppresses CAG stdout/stderr on success',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled({
        stdoutLine: 'cag-stdout-diagnostic',
        stderrLine: 'cag-stderr-diagnostic',
      });
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('cag-stdout-diagnostic');
      expect(result.stderr).not.toContain('cag-stderr-diagnostic');
    },
    { timeout: 30000 },
  );

  // `tool integrate` (the eager project-binding step) only ever ran for a
  // project-scope install with a resolved key. Every agent install is global
  // now, so that step — and its failure modes — is unreachable; the hook
  // resolves the project at runtime instead. No replacement test needed.

  it(
    'installs CAG on SonarQube Cloud with no project key',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      // No sonar-project.properties — projectKey is undefined.

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const invoked = readInvocations(harness).filter((i) => i.argv[1] === 'integrate');
      expect(invoked).toEqual([]);
      const state = loadState(harness);
      expect(findRecordedCagFeature(state)).toBeDefined();
      expectVortexHookInstalled(harness.userHome, 'claude', 'global');
    },
    { timeout: 30000 },
  );

  it(
    'emits info (not warn) and skips CAG on SonarQube Server without an org',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .start();
      // No org — SonarQube Server auth
      harness.withAuth(server.baseUrl(), TOKEN);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, `sonar.projectKey=${PROJECT_KEY}`].join('\n'),
      );

      // No SONARQUBE_CLI_SONARCLOUD_URL override → localhost is treated as SQS
      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      // No CAG subprocesses invoked
      const nonProbe = readInvocations(harness).filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      expectVortexHookAbsent(harness.cwd, 'claude');
      expect(result.stdout + result.stderr).toContain(
        'Vortex requires SonarQube Server 2026.5 Enterprise or later.',
      );
      expect(result.stdout + result.stderr).not.toContain('organization are required');
    },
    { timeout: 30000 },
  );
});

describe('integrate copilot — Context Augmentation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'installs the CAG session-start hook globally for copilot',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .withScaEnabled(false)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate copilot --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const invoked = readInvocations(harness).filter((i) => i.argv[1] === 'integrate');
      expect(invoked).toEqual([]);
      expect(result.stdout).not.toContain('Running: sonar-context-augmentation');
      expectVortexHookInstalled(harness.userHome, 'copilot', 'global');
      expectVortexHookAbsent(harness.cwd, 'copilot');

      // State records the declarative feature under the Copilot integration.
      const state = loadState(harness);
      expectRecordedCagFeature(state, {
        integrationId: COPILOT_INTEGRATION_ID,
        targetRoot: harness.userHome.path,
        scaEnabled: false,
        serverUrl,
      });
    },
    { timeout: 30000 },
  );
});

describe('integrate codex — Context Augmentation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'installs the CAG session-start hook globally for codex',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .withScaEnabled(false)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate codex --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const invoked = readInvocations(harness).filter((i) => i.argv[1] === 'integrate');
      expect(invoked).toEqual([]);
      expect(result.stdout).not.toContain('Running: sonar-context-augmentation');
      expectVortexHookInstalled(harness.userHome, 'codex', 'global');
      expectVortexHookAbsent(harness.cwd, 'codex');

      const state = loadState(harness);
      expectRecordedCagFeature(state, {
        integrationId: CODEX_INTEGRATION_ID,
        targetRoot: harness.userHome.path,
        scaEnabled: false,
        serverUrl,
      });
    },
    { timeout: 30000 },
  );

  it(
    'skips CAG entirely when __SQCLI_DEV_SKIP_CAG is set',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate codex --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          __SQCLI_DEV_SKIP_CAG: '1',
        },
      });

      expect(result.exitCode).toBe(0);
      const nonProbe = readInvocations(harness).filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      const state = loadState(harness);
      expect(findRecordedCagFeature(state)).toBeUndefined();
      expectVortexHookAbsent(harness.cwd, 'codex');
    },
    { timeout: 30000 },
  );

  it(
    'skips CAG with a warning when the org is not allowed to use it',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID, { allowed: false })
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate codex --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const nonProbe = readInvocations(harness).filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      expectVortexHookAbsent(harness.cwd, 'codex');
      expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_PROMOTION_MESSAGE);
    },
    { timeout: 30000 },
  );

  it(
    'installs CAG on SonarQube Cloud with no project key',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      // No sonar-project.properties — projectKey is undefined.

      const result = await harness.run('integrate codex --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const invoked = readInvocations(harness).filter((i) => i.argv[1] === 'integrate');
      expect(invoked).toEqual([]);
      expect(findRecordedCagFeature(loadState(harness))).toBeDefined();
      expectVortexHookInstalled(harness.userHome, 'codex', 'global');
    },
    { timeout: 30000 },
  );
});

describe('integrate cursor — Context Augmentation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'installs the CAG session-start hook globally for cursor',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .withScaEnabled(false)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate cursor --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const invoked = readInvocations(harness).filter((i) => i.argv[1] === 'integrate');
      expect(invoked).toEqual([]);
      expect(result.stdout).not.toContain('Running: sonar-context-augmentation');
      expectVortexHookInstalled(harness.userHome, 'cursor', 'global');
      expectVortexHookAbsent(harness.cwd, 'cursor');

      const state = loadState(harness);
      expectRecordedCagFeature(state, {
        integrationId: CURSOR_INTEGRATION_ID,
        targetRoot: harness.userHome.path,
        scaEnabled: false,
        serverUrl,
      });
    },
    { timeout: 30000 },
  );
});

describe('integrate <agent> — Context Augmentation (global install, no project)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  const AGENTS = [
    ['claude', 'integrate claude --non-interactive'],
    ['copilot', 'integrate copilot --non-interactive'],
    ['codex', 'integrate codex --non-interactive'],
    ['cursor', 'integrate cursor --non-interactive'],
  ] as const;

  it.each(AGENTS)(
    'installs CAG under the global root on "integrate %s" when the org is entitled',
    async (agent, command) => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);

      const result = await harness.run(command, {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      // `tool integrate` needs a project key, so a global install ships the hook
      // without binding the binary to one.
      const invoked = readInvocations(harness).filter((i) => i.argv[1] === 'integrate');
      expect(invoked).toEqual([]);
      expect(findRecordedCagFeature(loadState(harness))?.feature.scope).toBe('global');
      expectVortexHookInstalled(harness.userHome, agent, 'global');
      expectVortexHookAbsent(harness.cwd, agent);
    },
    { timeout: 30000 },
  );

  it.each(AGENTS)(
    'skips CAG entirely on "integrate %s" when the org is not entitled',
    async (agent, command) => {
      // No CAG entitlement configured on the server.
      const server = await harness.newFakeServer().withAuthToken(TOKEN).start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);

      const result = await harness.run(command, {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const nonProbe = readInvocations(harness).filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      const state = loadState(harness);
      expect(findRecordedCagFeature(state)).toBeUndefined();
      expectVortexHookAbsent(harness.userHome, agent, 'global');
    },
    { timeout: 30000 },
  );
});
