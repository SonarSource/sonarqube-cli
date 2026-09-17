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

// Integration tests for `sonar integrate git`

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  expectAgentPromptHint,
  expectNoAgentPromptHint,
} from '../../../_common/agent-hint-assertions.js';
import { ISOLATED_CLI_SPAWN_ENV } from '../../../_common/isolated-cli-env.js';
import { readCommandEvents } from '../../../_common/telemetry-helpers.ts';
import { type CliResult, TestHarness } from '../../harness';
import { getCliBinaryPath } from '../../harness/cli-runner.js';
import { buildHomeEnv, IS_WINDOWS } from '../../harness/platform';

const PATH_DELIM = IS_WINDOWS ? ';' : ':';
function pathWithoutNodeModules(envPath: string | undefined): string {
  return (envPath ?? '')
    .split(PATH_DELIM)
    .filter((p) => !p.includes('node_modules'))
    .join(PATH_DELIM);
}

// Intentional fixture for secret detection (split literal avoids hardcoded-secret rules)
const GITHUB_TEST_TOKEN = 'ghp_' + 'CID7e8gGxQcMIJeFmEfRsV3zkXPUC42CjFbm';

/** Env for `git commit` / `git push` so the installed hook sees the same HOME + keychain as `harness.run()`. */
function buildHookEnv(sonarBinDir: string, harness: TestHarness): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    ...buildHomeEnv(harness.userHome.path),
    SONARQUBE_CLI_KEYCHAIN_FILE: harness.keychainJsonFile,
    PATH: `${sonarBinDir}${PATH_DELIM}${pathWithoutNodeModules(process.env.PATH)}`,
  };
  // On Windows, process.env may use "Path" instead of "PATH". Both keys would
  // coexist in the object, and the OS may pick the wrong one. Remove the original.
  if (IS_WINDOWS) {
    delete env.Path;
  }
  return { ...env, ...ISOLATED_CLI_SPAWN_ENV };
}

function setupSonarBinDir(harness: TestHarness): {
  sonarBinDir: string;
  hookEnv: Record<string, string>;
} {
  const sonarBinDir = join(harness.cwd.path, 'sonar-bin');
  mkdirSync(sonarBinDir, { recursive: true });

  // Symlinks require Developer Mode or admin privileges on Windows; copy instead.
  const binaryName = IS_WINDOWS ? 'sonar.exe' : 'sonar';
  copyFileSync(getCliBinaryPath(), join(sonarBinDir, binaryName));

  return { sonarBinDir, hookEnv: buildHookEnv(sonarBinDir, harness) };
}

function setupGitUser(cwd: string): void {
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test User'], { cwd });
}

function addBareRemote(cwd: string): void {
  const remotePath = join(cwd, '..', 'remote.git');
  mkdirSync(remotePath, { recursive: true });
  Bun.spawnSync(['git', 'init', '--bare'], { cwd: remotePath });
  Bun.spawnSync(['git', 'remote', 'add', 'origin', remotePath], { cwd });
  Bun.spawnSync(['git', 'branch', '-M', 'main'], { cwd });
}

function gitCommit(
  cwd: string,
  env: Record<string, string>,
  message: string,
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(['git', 'commit', '-m', message], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function gitPush(
  cwd: string,
  env: Record<string, string>,
  setUpstream: boolean,
): ReturnType<typeof Bun.spawnSync> {
  const args = setUpstream
    ? ['git', 'push', '-u', 'origin', 'main']
    : ['git', 'push', 'origin', 'main'];
  return Bun.spawnSync(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
}

const INTEGRATION_TEST_TOKEN = 'test-token';

type InstalledSubfeatureJson = {
  featureId: string;
  dependencies: Array<{ id: string }>;
};

type InstalledStateJson = {
  dependencies: {
    installed: Array<{
      id: string;
    }>;
  };
  integrations: {
    installed: Array<{
      integrationId: string;
      features: Array<{
        featureId: string;
        scope: string;
        targetRoot: string;
        attrs?: Record<string, unknown>;
        dependencies: Array<{ id: string }>;
        resources: Array<{ id: string; resourceType: string }>;
        operations: Array<{ id: string }>;
        subfeatures?: InstalledSubfeatureJson[];
      }>;
    }>;
  };
};

type InstalledIntegrationJson = InstalledStateJson['integrations']['installed'][number];
type InstalledFeatureJson = InstalledIntegrationJson['features'][number];

function getInstalledIntegration(state: InstalledStateJson, integrationId: string) {
  const integration = state.integrations.installed.find(
    (entry) => entry.integrationId === integrationId,
  );
  expect(integration).toBeDefined();
  return integration!;
}

function expectInstalledDependency(state: InstalledStateJson, id: string): void {
  const dependency = state.dependencies.installed.find((entry) => entry.id === id);
  expect(dependency).toBeDefined();
}

function expectSubfeatureHasDependency(
  feature: InstalledFeatureJson,
  subfeatureId: string,
  dependencyId: string,
): void {
  const subfeature = feature.subfeatures?.find((s) => s.featureId === subfeatureId);
  expect(subfeature).toBeDefined();
  expect(subfeature?.dependencies.some((d) => d.id === dependencyId)).toBe(true);
}

function expectInstalledResource(
  feature: InstalledFeatureJson,
  id: string,
  resourceType: string,
): void {
  const resource = feature.resources.find((entry) => entry.id === id);
  expect(resource).toBeDefined();
  expect(resource?.resourceType).toBe(resourceType);
}

function expectInstalledOperation(feature: InstalledFeatureJson, id: string): void {
  const operation = feature.operations.find((entry) => entry.id === id);
  expect(operation).toBeDefined();
  expect(operation?.id).toBe(id);
}

type SetupAuthOptions = { withSecretsBinary?: boolean; scaEnabled?: boolean };

async function setupAuthenticated(
  harness: TestHarness,
  options: SetupAuthOptions = {},
): Promise<void> {
  const serverBuilder = harness.newFakeServer().withAuthToken(INTEGRATION_TEST_TOKEN);
  if (options.scaEnabled) {
    serverBuilder.withVersion('2026.4.0.0').withScaEnabled(true);
  }
  const server = await serverBuilder.start();
  const chain = harness
    .state()
    .withActiveConnection(server.baseUrl())
    .withKeychainToken(server.baseUrl(), INTEGRATION_TEST_TOKEN);
  if (options.withSecretsBinary) {
    chain.withSecretsBinaryInstalled();
  }
}

function initGitRepo(harness: TestHarness): void {
  mkdirSync(harness.cwd.path, { recursive: true });
  Bun.spawnSync(['git', 'init'], { cwd: harness.cwd.path });
  // Isolate from host git config so line-ending settings (autocrlf) don't break tests
  Bun.spawnSync(['git', 'config', 'core.autocrlf', 'false'], { cwd: harness.cwd.path });
}

describe('integrate git (native hooks)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with error when user is not authenticated',
    async () => {
      // No keychain token, no env vars — resolveAuth() throws
      const result = await harness.run('integrate git --non-interactive');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Not authenticated');
    },
    { timeout: 15000 },
  );

  it(
    'pre-commit hook blocks commit when staged file contains a secret',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');
      expect(result.exitCode).toBe(0);
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit')).toBe(true);
      expect(result.stdout).toContain('Setup complete!');
      expect(result.stdout).toContain('Verify the pre-commit hook works');

      const { hookEnv } = setupSonarBinDir(harness);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      Bun.spawnSync(['git', 'add', 'secret.js'], { cwd: harness.cwd.path });
      setupGitUser(harness.cwd.path);

      const commit = gitCommit(harness.cwd.path, hookEnv, 'wip');
      expect(commit.exitCode).not.toBe(0);
      const output = (commit.stdout?.toString() ?? '') + (commit.stderr?.toString() ?? '');
      expect(output).toContain('Secrets detected');
    },
    { timeout: 30000 },
  );

  it(
    'pre-push hook blocks push when commit contains a secret',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      const result = await harness.run('integrate git --hook pre-push --non-interactive');
      expect(result.exitCode).toBe(0);
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-push')).toBe(true);
      expect(result.stdout).toContain('Setup complete!');
      expect(result.stdout).toContain('Verify the pre-push hook works');

      const { hookEnv } = setupSonarBinDir(harness);
      setupGitUser(harness.cwd.path);

      // First commit + push: clean file, should succeed
      harness.cwd.writeFile('clean.js', 'const x = 1;\n');
      Bun.spawnSync(['git', 'add', 'clean.js'], { cwd: harness.cwd.path });
      gitCommit(harness.cwd.path, hookEnv, 'initial');
      addBareRemote(harness.cwd.path);
      const firstPush = gitPush(harness.cwd.path, hookEnv, true);
      expect(firstPush.exitCode).toBe(0);

      // Second commit + push: file with secret, should be blocked by pre-push hook
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      Bun.spawnSync(['git', 'add', 'secret.js'], { cwd: harness.cwd.path });
      gitCommit(harness.cwd.path, hookEnv, 'wip');
      const secondPush = gitPush(harness.cwd.path, hookEnv, false);

      expect(secondPush.exitCode).not.toBe(0);
      const output = (secondPush.stdout?.toString() ?? '') + (secondPush.stderr?.toString() ?? '');
      expect(output).toContain('Secrets detected');
    },
    { timeout: 30000 },
  );

  it(
    'installs all hooks when --non-interactive is used without --hook',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      // No --hook flag: shouldInstallHook() defaults to ask, which the installer
      // resolves to install for every hook in --non-interactive mode.
      const result = await harness.run('integrate git --non-interactive');

      expect(result.exitCode).toBe(0);
      const bothHooksOutput = result.stdout + result.stderr;
      expect(bothHooksOutput).toContain('✓  pre-commit code scanning hook');
      expect(bothHooksOutput).toContain('✓  pre-push code scanning hook');
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit')).toBe(true);
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-push')).toBe(true);

      // Both hooks installed -> a single merged verification example box.
      expect(bothHooksOutput).toContain('Verify the hooks work');
      expect(bothHooksOutput).toContain('Pre-commit — stage and commit:');
      expect(bothHooksOutput).toContain('Pre-push — bypass pre-commit, then push:');

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      expect(gitIntegration.features).toHaveLength(2);
      expect(
        gitIntegration.features
          .map((feature) => feature.featureId)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(['pre-commit-hook', 'pre-push-hook']);
    },
    { timeout: 15000 },
  );

  it(
    'records hook installation in state',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      expect(gitIntegration.features).toHaveLength(1);
      const feature = gitIntegration.features[0];
      expect(feature).toMatchObject({
        featureId: 'pre-commit-hook',
        scope: 'global',
        targetRoot: harness.userHome.file('.sonar', 'sonarqube-cli', 'hooks').path,
      });
      expectSubfeatureHasDependency(feature, 'pre-commit-secrets', 'sonar-secrets');
      expectInstalledResource(feature, 'hook-file', 'whole-file');
      expectInstalledDependency(state, 'sonar-secrets');
    },
    { timeout: 15000 },
  );

  it(
    'installs both native hooks when the user accepts each per-feature prompt',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      // Accept pre-commit and pre-push. Dep-risks is auto-skipped (SCA unavailable).
      const session = harness.runInteractive('integrate git');
      await session.accept('Proceed with global installation?');
      await session.accept('Install pre-commit code scanning hook?');
      await session.accept('Install pre-push code scanning hook?');
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Install pre-commit code scanning hook?');
      expect(output).toContain('Install pre-push code scanning hook?');
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit')).toBe(true);
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-push')).toBe(true);

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      const featureIds = gitIntegration.features
        .map((feature) => feature.featureId)
        .sort((a, b) => a.localeCompare(b));
      expect(featureIds).toEqual(['pre-commit-hook', 'pre-push-hook']);
    },
    { timeout: 15000 },
  );

  it(
    'records project_uuid as null on CliCommandExecuted for a global install',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(INTEGRATION_TEST_TOKEN)
        .withProject('my-project')
        .start();
      // Do NOT enable flush mode: TELEMETRY_FLUSH_MODE_ENV no-ops commitTelemetryFacts(), which owns
      // CliCommandExecuted, so the command event would never be written.
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), INTEGRATION_TEST_TOKEN)
        .withSecretsBinaryInstalled()
        .withTelemetryEnabled();

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      const [commandEvent] = readCommandEvents(harness.sonarUserHome.path);
      expect(commandEvent.event_payload.command).toBe('integrate');
      expect(commandEvent.event_payload.subcommand).toBe('git');
      expect(commandEvent.event_payload.project_uuid).toBeNull();
    },
    { timeout: 15000 },
  );

  it(
    'skips dep-risks silently when SCA is not enabled on the server',
    async () => {
      // No scaEnabled: true → fake server returns 404 for the SCA endpoint → check_failed → skip.
      await setupAuthenticated(harness, { withSecretsBinary: true });

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      const hookContent = readFileSync(
        harness.userHome.file('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit').path,
        'utf-8',
      );
      expect(hookContent).not.toContain('--dependency-risks');

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      const feature = gitIntegration.features[0];
      expect(
        feature.subfeatures?.find((s) => s.featureId === 'pre-commit-dependency-risks'),
      ).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'skips dep-risks and prints a message when SCA is not enabled',
    async () => {
      // Version-compatible server but SCA feature disabled: assertScaAvailable passes the
      // version check then throws on the enablement check, so dep-risks is skipped.
      const server = await harness
        .newFakeServer()
        .withAuthToken(INTEGRATION_TEST_TOKEN)
        .withVersion('2026.4.0.0')
        .start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), INTEGRATION_TEST_TOKEN)
        .withSecretsBinaryInstalled();

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'Software Composition Analysis is not available for the current connection.',
      );
      const hookContent = readFileSync(
        harness.userHome.file('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit').path,
        'utf-8',
      );
      expect(hookContent).not.toContain('--dependency-risks');
    },
    { timeout: 15000 },
  );

  it(
    'declining the dependency-risks prompt installs the hook without dependency-risks scanning',
    async () => {
      // sca-scanner-cli is intentionally not pre-installed, so its absence below is conclusive.
      await setupAuthenticated(harness, { withSecretsBinary: true, scaEnabled: true });
      harness.state().withScaScannerBinaryInstalled();

      const session = harness.runInteractive('integrate git');
      await session.accept('Proceed with global installation?');
      await session.accept('Install pre-commit code scanning hook?');
      await session.decline('Install pre-commit dependency-risks scan?');
      await session.decline('Install pre-push code scanning hook?');
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      const hookContent = readFileSync(
        harness.userHome.file('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit').path,
        'utf-8',
      );
      expect(hookContent).not.toContain('--dependency-risks');

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      const feature = gitIntegration.features[0];
      expect(feature.featureId).toBe('pre-commit-hook');
      expect(feature.subfeatures?.some((s) => s.featureId === 'pre-commit-dependency-risks')).toBe(
        false,
      );
    },
    { timeout: 30000 },
  );

  it(
    'fails with an explicit notice when the user declines every per-feature prompt',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      const session = harness.runInteractive('integrate git');
      await session.accept('Proceed with global installation?');
      await session.decline('Install pre-commit code scanning hook?');
      await session.decline('Install pre-push code scanning hook?');
      const result = await session.waitFinish();

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'No feature selected for Native Git integration',
      );
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit')).toBe(false);
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-push')).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'installs native pre-commit hook via interactive prompts when secrets is already installed',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      const session = harness.runInteractive('integrate git');
      await session.accept('Proceed with global installation?');
      await session.accept('Install pre-commit code scanning hook?');
      await session.decline('Install pre-push code scanning hook?');
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('✓  pre-commit code scanning hook');
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit')).toBe(true);
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-push')).toBe(false);
    },
    { timeout: 15000 },
  );

  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])(
    'prints a non-interactive hint before the global-install confirmation only for a detected AI agent without --non-interactive (isAgent=%s, isInteractive=%s, expectedShownPrompt=%s)',
    async (isAgent, isInteractive, expectedShownPrompt) => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      const extraEnv: Record<string, string> = isAgent ? { CLAUDECODE: '1' } : {};
      let result: CliResult;
      if (isInteractive) {
        const session = harness.runInteractive('integrate git', { extraEnv });
        await session.accept('Proceed with global installation?');
        await session.accept('Install pre-commit code scanning hook?');
        await session.decline('Install pre-push code scanning hook?');
        result = await session.waitFinish();
      } else {
        result = await harness.run('integrate git --non-interactive', { extraEnv });
      }

      expect(result.exitCode).toBe(0);
      if (expectedShownPrompt) {
        expectAgentPromptHint(result.stdout, 'sonar integrate git --non-interactive');
      } else {
        expectNoAgentPromptHint(result.stdout);
      }
    },
    { timeout: 15000 },
  );

  it(
    'records global hook installation in state',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      const result = await harness.run('integrate git --hook pre-push --non-interactive');

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      const feature = gitIntegration.features[0];
      expect(feature).toMatchObject({
        featureId: 'pre-push-hook',
        scope: 'global',
        targetRoot: harness.userHome.file('.sonar', 'sonarqube-cli', 'hooks').path,
      });
      expectInstalledOperation(feature, 'configure-global-hooks-path');
    },
    { timeout: 15000 },
  );

  it(
    'installs native global pre-push hook via interactive prompts when secrets is already installed',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      const session = harness.runInteractive('integrate git');
      await session.accept('Proceed with global installation?');
      await session.decline('Install pre-commit code scanning hook?');
      await session.accept('Install pre-push code scanning hook?');
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('✓  pre-push code scanning hook');
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-push')).toBe(true);
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit')).toBe(false);
    },
    { timeout: 15000 },
  );

  describe('global hook chains to a pre-existing local hook', () => {
    const OLD_HOOK_MARKER_FILE = 'old-hook-ran.txt';

    function writePreExistingHook(
      harness: TestHarness,
      script: string,
      hook: 'pre-commit' | 'pre-push' = 'pre-commit',
    ): void {
      const hookPath = join(harness.cwd.path, '.git', 'hooks', hook);
      mkdirSync(join(harness.cwd.path, '.git', 'hooks'), { recursive: true });
      writeFileSync(hookPath, script, { mode: 0o755 });
      chmodSync(hookPath, 0o755);
    }

    it(
      'runs the pre-existing hook before Sonar’s own check, then still blocks a secret',
      async () => {
        await setupAuthenticated(harness, { withSecretsBinary: true });
        initGitRepo(harness);
        writePreExistingHook(harness, `#!/bin/sh\necho ran >> ${OLD_HOOK_MARKER_FILE}\nexit 0\n`);

        const install = await harness.run('integrate git --non-interactive');
        expect(install.exitCode).toBe(0);
        // The repo's own pre-existing hook is untouched — global scope never writes here.
        expect(
          readFileSync(join(harness.cwd.path, '.git', 'hooks', 'pre-commit'), 'utf-8'),
        ).toContain('echo ran');

        const { hookEnv } = setupSonarBinDir(harness);
        setupGitUser(harness.cwd.path);
        harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
        Bun.spawnSync(['git', 'add', 'secret.js'], { cwd: harness.cwd.path });

        const commit = gitCommit(harness.cwd.path, hookEnv, 'wip');

        expect(commit.exitCode).not.toBe(0);
        const output = (commit.stdout?.toString() ?? '') + (commit.stderr?.toString() ?? '');
        expect(output).toContain('Secrets detected');
        // Proves the old hook actually executed (chaining happened), not just that Sonar's ran.
        expect(harness.cwd.exists(OLD_HOOK_MARKER_FILE)).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'aborts the commit when the pre-existing hook fails, without ever running Sonar’s check',
      async () => {
        await setupAuthenticated(harness, { withSecretsBinary: true });
        initGitRepo(harness);
        writePreExistingHook(harness, `#!/bin/sh\necho OLD-HOOK-FAILED\nexit 1\n`);

        const install = await harness.run('integrate git --non-interactive');
        expect(install.exitCode).toBe(0);

        const { hookEnv } = setupSonarBinDir(harness);
        setupGitUser(harness.cwd.path);
        harness.cwd.writeFile('clean.js', 'const x = 1;\n');
        Bun.spawnSync(['git', 'add', 'clean.js'], { cwd: harness.cwd.path });

        const commit = gitCommit(harness.cwd.path, hookEnv, 'wip');

        expect(commit.exitCode).not.toBe(0);
        const output = (commit.stdout?.toString() ?? '') + (commit.stderr?.toString() ?? '');
        expect(output).toContain('OLD-HOOK-FAILED');
        // Sonar's own secrets scan never ran — no "Secrets detected" output for this clean file,
        // and the abort happened before Sonar's part of the script.
        expect(output).not.toContain('Secrets detected');
      },
      { timeout: 30000 },
    );

    it(
      'does not double-chain when the pre-existing hook is itself an old Sonar-installed hook',
      async () => {
        await setupAuthenticated(harness, { withSecretsBinary: true });
        initGitRepo(harness);
        // Simulates a per-repo install from before global scope existed: same marker Sonar's
        // own native hook uses, so the chain block must recognize and skip it.
        writePreExistingHook(
          harness,
          [
            '#!/bin/sh',
            '# sonar pre-commit hook - installed by sonar integrate git',
            `echo ran >> ${OLD_HOOK_MARKER_FILE}`,
            'exit 0',
            '',
          ].join('\n'),
        );

        const install = await harness.run('integrate git --non-interactive');
        expect(install.exitCode).toBe(0);

        const { hookEnv } = setupSonarBinDir(harness);
        setupGitUser(harness.cwd.path);
        harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
        Bun.spawnSync(['git', 'add', 'secret.js'], { cwd: harness.cwd.path });

        const commit = gitCommit(harness.cwd.path, hookEnv, 'wip');

        // The GLOBAL hook's own secrets check still ran and blocked the commit...
        expect(commit.exitCode).not.toBe(0);
        const output = (commit.stdout?.toString() ?? '') + (commit.stderr?.toString() ?? '');
        expect(output).toContain('Secrets detected');
        // ...but the old marked-as-Sonar hook was recognized and skipped, not executed again.
        expect(harness.cwd.exists(OLD_HOOK_MARKER_FILE)).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'pre-push: chains to a hook that reads stdin, and Sonar still detects a secret afterward',
      async () => {
        await setupAuthenticated(harness, { withSecretsBinary: true });
        initGitRepo(harness);
        // A realistic pre-push hook actually reads the ref list from stdin — this is exactly the
        // scenario that would silently disable Sonar's scan without the stdin capture-and-replay.
        writePreExistingHook(
          harness,
          [
            '#!/bin/sh',
            `LINES=$(cat | wc -l)`,
            `echo "ran-saw-$LINES-lines" >> ${OLD_HOOK_MARKER_FILE}`,
            'exit 0',
            '',
          ].join('\n'),
          'pre-push',
        );

        const install = await harness.run('integrate git --hook pre-push --non-interactive');
        expect(install.exitCode).toBe(0);

        const { hookEnv } = setupSonarBinDir(harness);
        setupGitUser(harness.cwd.path);

        // First commit + push: clean file, should succeed and still run the chained old hook.
        harness.cwd.writeFile('clean.js', 'const x = 1;\n');
        Bun.spawnSync(['git', 'add', 'clean.js'], { cwd: harness.cwd.path });
        gitCommit(harness.cwd.path, hookEnv, 'initial');
        addBareRemote(harness.cwd.path);
        const firstPush = gitPush(harness.cwd.path, hookEnv, true);
        expect(firstPush.exitCode).toBe(0);
        // The chained hook actually read a non-empty ref list — proves stdin wasn't already
        // drained empty before it ran.
        const oldHookLog = readFileSync(join(harness.cwd.path, OLD_HOOK_MARKER_FILE), 'utf-8');
        expect(oldHookLog).toMatch(/ran-saw-\s*[1-9]\d*-lines/);

        // Second commit + push: file with a secret. If Sonar's scan lost its stdin (the bug this
        // capture-and-replay fixes), this would wrongly succeed instead of being blocked.
        harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
        Bun.spawnSync(['git', 'add', 'secret.js'], { cwd: harness.cwd.path });
        gitCommit(harness.cwd.path, hookEnv, 'wip');
        const secondPush = gitPush(harness.cwd.path, hookEnv, false);

        expect(secondPush.exitCode).not.toBe(0);
        const output =
          (secondPush.stdout?.toString() ?? '') + (secondPush.stderr?.toString() ?? '');
        expect(output).toContain('Secrets detected');
      },
      { timeout: 30000 },
    );

    it(
      'chains to the pre-existing hook when committing from a linked worktree',
      async () => {
        await setupAuthenticated(harness, { withSecretsBinary: true });
        initGitRepo(harness);
        writePreExistingHook(harness, `#!/bin/sh\necho ran >> ${OLD_HOOK_MARKER_FILE}\nexit 0\n`);

        const install = await harness.run('integrate git --non-interactive');
        expect(install.exitCode).toBe(0);

        const { hookEnv } = setupSonarBinDir(harness);
        setupGitUser(harness.cwd.path);
        // A worktree needs an existing commit to branch from.
        harness.cwd.writeFile('initial.js', 'const x = 1;\n');
        Bun.spawnSync(['git', 'add', 'initial.js'], { cwd: harness.cwd.path });
        gitCommit(harness.cwd.path, hookEnv, 'initial');

        const worktreePath = join(harness.cwd.path, '..', 'linked-worktree');
        const worktreeAdd = Bun.spawnSync(
          ['git', 'worktree', 'add', worktreePath, '-b', 'linked-branch'],
          { cwd: harness.cwd.path, env: hookEnv },
        );
        expect(worktreeAdd.exitCode).toBe(0);

        writeFileSync(join(worktreePath, 'secret.js'), `const token = "${GITHUB_TEST_TOKEN}";`);
        Bun.spawnSync(['git', 'add', 'secret.js'], { cwd: worktreePath });

        const commit = gitCommit(worktreePath, hookEnv, 'wip');

        expect(commit.exitCode).not.toBe(0);
        const output = (commit.stdout?.toString() ?? '') + (commit.stderr?.toString() ?? '');
        expect(output).toContain('Secrets detected');
        // The old hook's marker lands in the worktree (git hooks run with the invoking
        // worktree as cwd) — proves --git-common-dir found the shared hook from there.
        expect(existsSync(join(worktreePath, OLD_HOOK_MARKER_FILE))).toBe(true);
      },
      { timeout: 30000 },
    );
  });

  it(
    'bakes a project-agnostic dependency-risks scan into the global pre-commit hook',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true, scaEnabled: true });
      harness.state().withScaScannerBinaryInstalled();

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);

      const hookContent = readFileSync(
        harness.userHome.file('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit').path,
        'utf-8',
      );
      expect(hookContent).toContain('hook git-pre-commit --dependency-risks\n');
      expect(hookContent).not.toContain('--dependency-risks -p');

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      const feature = gitIntegration.features[0];
      expect(feature.featureId).toBe('pre-commit-hook');
      expect(feature.attrs).toBeUndefined();
      expectSubfeatureHasDependency(feature, 'pre-commit-secrets', 'sonar-secrets');
      expectSubfeatureHasDependency(feature, 'pre-commit-dependency-risks', 'sca-scanner-cli');
      expectInstalledDependency(state, 'sca-scanner-cli');
    },
    { timeout: 15000 },
  );

  it(
    'does not apply dependency-risks to the pre-push hook',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true, scaEnabled: true });
      harness.state().withScaScannerBinaryInstalled();

      const result = await harness.run('integrate git --hook pre-push --non-interactive');

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      expect(gitIntegration.features.some((f) => f.featureId === 'pre-commit-hook')).toBe(false);
      const pushFeature = gitIntegration.features.find((f) => f.featureId === 'pre-push-hook');
      expect(pushFeature).toBeDefined();
      expect(pushFeature?.subfeatures).toBeUndefined();
    },
    { timeout: 15000 },
  );
});

describe('integrate git --local (CLI-1118)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'is hidden from --help',
    async () => {
      const result = await harness.run('integrate git --help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('--local');
    },
    { timeout: 15000 },
  );

  it(
    'fails when run outside a git repository',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      const result = await harness.run('integrate git --local --non-interactive');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('No git repository found');
    },
    { timeout: 15000 },
  );

  it(
    'installs a project-scoped native hook when neither husky nor pre-commit is in use',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      const result = await harness.run('integrate git --local --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Setup complete!');
      expect(harness.cwd.exists('.git', 'hooks', 'pre-commit')).toBe(true);
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit')).toBe(false);

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      expect(gitIntegration.features[0].scope).toBe('project');
      expect(gitIntegration.features[0].targetRoot).toBe(harness.cwd.path);
    },
    { timeout: 15000 },
  );

  it(
    'installs the husky integration when core.hooksPath points to .husky',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);
      mkdirSync(join(harness.cwd.path, '.husky'), { recursive: true });
      Bun.spawnSync(['git', 'config', 'core.hooksPath', '.husky'], { cwd: harness.cwd.path });

      const result = await harness.run('integrate git --local --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const huskyIntegration = getInstalledIntegration(state, 'husky');
      expect(huskyIntegration.features[0].scope).toBe('project');
    },
    { timeout: 15000 },
  );

  // Pre-commit-framework detection (.pre-commit-config.yaml present) is deliberately not
  // covered here: activating it shells out to the real `pre-commit` binary, which isn't
  // guaranteed to be installed in every dev/CI environment — the same reason its install
  // mechanics are unit-tested with a mocked spawnProcess in
  // tests/unit/commands/integrate/git/git-precommit-framework.test.ts instead. The routing
  // logic that picks it (resolveGitIntegrationId) is unchanged by --local and already
  // exercised for the husky case above.

  it(
    'bakes the discovered project key into the hook attrs',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);
      harness.cwd.writeFile('sonar-project.properties', 'sonar.projectKey=my-project\n');

      const result = await harness.run('integrate git --local --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      expect(gitIntegration.features[0].attrs).toMatchObject({ projectKey: 'my-project' });
    },
    { timeout: 15000 },
  );

  it(
    'still installs globally by default when --local is omitted',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      expect(gitIntegration.features[0].scope).toBe('global');
    },
    { timeout: 15000 },
  );

  it(
    'installs into the repo, not the inherited global hooks dir, after a prior global install',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      const globalHookFile = ['.sonar', 'sonarqube-cli', 'hooks', 'pre-commit'];
      const globalInstall = await harness.run('integrate git --hook pre-commit --non-interactive');
      expect(globalInstall.exitCode).toBe(0);
      expect(harness.userHome.exists(...globalHookFile)).toBe(true);
      const globalHookBefore = harness.userHome.file(...globalHookFile).asText();

      // No repo-local core.hooksPath is set — only the global one from the install above.
      const localInstall = await harness.run(
        'integrate git --local --hook pre-commit --non-interactive',
      );

      expect(localInstall.exitCode).toBe(0);
      expect(harness.cwd.exists('.git', 'hooks', 'pre-commit')).toBe(true);
      // The global hook file must be untouched — --local must not follow the inherited
      // global core.hooksPath and overwrite it with project-scoped content.
      expect(harness.userHome.file(...globalHookFile).asText()).toBe(globalHookBefore);

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      const projectFeature = gitIntegration.features.find((f) => f.scope === 'project');
      expect(projectFeature?.targetRoot).toBe(harness.cwd.path);
    },
    { timeout: 15000 },
  );

  it(
    'warns that the local hook is shadowed by an inherited global core.hooksPath',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      const globalInstall = await harness.run('integrate git --hook pre-commit --non-interactive');
      expect(globalInstall.exitCode).toBe(0);

      // No repo-local core.hooksPath is set — only the global one from the install above,
      // so the hook --local installs at .git/hooks will never actually run.
      const localInstall = await harness.run(
        'integrate git --local --hook pre-commit --non-interactive',
      );

      expect(localInstall.exitCode).toBe(0);
      const output = localInstall.stdout + localInstall.stderr;
      expect(output).toContain('takes precedence over');
      expect(output).toContain('git config --local core.hooksPath');
    },
    { timeout: 15000 },
  );

  it(
    'does not warn when --local resolves to a husky hooks dir (repo-local override already matches)',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);
      mkdirSync(join(harness.cwd.path, '.husky'), { recursive: true });
      Bun.spawnSync(['git', 'config', 'core.hooksPath', '.husky'], { cwd: harness.cwd.path });

      const localInstall = await harness.run(
        'integrate git --local --hook pre-commit --non-interactive',
      );

      expect(localInstall.exitCode).toBe(0);
      const output = localInstall.stdout + localInstall.stderr;
      expect(output).not.toContain('takes precedence over');
    },
    { timeout: 15000 },
  );
});
