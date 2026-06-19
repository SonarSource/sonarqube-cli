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

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import yaml from 'js-yaml';

import { ISOLATED_CLI_SPAWN_ENV } from '../../../_common/isolated-cli-env.js';
import { TestHarness } from '../../harness';
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
const LEGACY_PRE_COMMIT_REPO = 'https://github.com/SonarSource/sonar-secrets-pre-commit';

// Project-scope interactive runs spawn `git` (e.g. resolveGitIntegrationId ->
// usesHusky) between the per-feature confirm prompts. That latency races the
// default 300 ms stdin chunk spacing and can drop a keystroke before the next
// prompt starts listening, so give those chunks extra room.
const PROJECT_PROMPT_CHUNK_DELAY_MS = 900;

type InstalledSubfeatureJson = {
  featureId: string;
  dependencies: Array<{ id: string }>;
};

type InstalledStateJson = {
  dependencies: {
    installed: Array<{
      id: string;
      dependencyType: string;
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

type PreCommitYamlConfig = {
  repos: Array<{
    repo: string;
    hooks: Array<{ id: string; stages?: string[]; entry?: string; pass_filenames?: boolean }>;
  }>;
};

function getInstalledIntegration(state: InstalledStateJson, integrationId: string) {
  const integration = state.integrations.installed.find(
    (entry) => entry.integrationId === integrationId,
  );
  expect(integration).toBeDefined();
  return integration!;
}

function expectInstalledDependency(
  state: InstalledStateJson,
  id: string,
  dependencyType: string,
): void {
  const dependency = state.dependencies.installed.find((entry) => entry.id === id);
  expect(dependency).toBeDefined();
  expect(dependency?.dependencyType).toBe(dependencyType);
}

function expectFeatureDependency(feature: InstalledFeatureJson, id: string): void {
  const dependency = feature.dependencies.find((entry) => entry.id === id);
  expect(dependency).toBeDefined();
  expect(dependency?.id).toBe(id);
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

function readCommandLog(path: string): string[] {
  return readFileSync(path, 'utf-8').split(/\r?\n/).filter(Boolean);
}

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function readYamlFile<T>(path: string): T {
  return yaml.load(readFileSync(path, 'utf-8')) as T;
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

function initGitRepoWithHusky(harness: TestHarness): void {
  initGitRepo(harness);
  Bun.spawnSync(['git', 'config', 'core.hooksPath', '.husky'], { cwd: harness.cwd.path });
  mkdirSync(join(harness.cwd.path, '.husky'), { recursive: true });
}

function initGitRepoWithPreCommitConfig(harness: TestHarness): void {
  initGitRepo(harness);
  harness.cwd.writeFile('.pre-commit-config.yaml', 'repos: []\n');
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
    'exits with error when user cancels the scope selection',
    async () => {
      await setupAuthenticated(harness);

      // Minimal git repo: findGitRoot() detects the .git directory
      harness.cwd.writeFile('.git/.keep', '');

      // Ctrl+C sent to stdin cancels the scope prompt after the repository summary
      const result = await harness.run('integrate git', { stdin: '\x03' });

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Installation cancelled');
    },
    { timeout: 15000 },
  );

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
    'defaults to project scope in non-interactive mode and logs an info line',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('defaulting to this project');
    },
    { timeout: 15000 },
  );

  it(
    'exits with error when run outside a git repository',
    async () => {
      await setupAuthenticated(harness);

      // No .git directory — discoverProject() sets isGitRepo: false
      const result = await harness.run('integrate git --non-interactive');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('No git repository found');
    },
    { timeout: 15000 },
  );

  it(
    'exits with error when a malformed .git worktree pointer makes git rev-parse fail',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      // findGitRoot() accepts .git files (worktree pointers), but this one points
      // to a non-existent gitdir so git rev-parse --git-path hooks fails.
      harness.cwd.writeFile('.git', 'gitdir: not-a-real-git-dir\n');

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Could not resolve git hooks directory');
      expect(output).toContain(
        'Make sure you run this command inside a valid git repository, and check that the repository metadata (.git directory or worktree pointer) is not corrupted, then retry.',
      );
      expect(output).not.toContain('available on PATH');
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
      expect(harness.cwd.exists('.git', 'hooks', 'pre-commit')).toBe(true);
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
      expect(harness.cwd.exists('.git', 'hooks', 'pre-push')).toBe(true);
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
    'installs native pre-commit hook via interactive prompts when secrets is already installed',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      // Real git repo so that git commands (e.g. git config core.hooksPath) behave correctly
      // and resolveGitHooksDir() resolves to .git/hooks as expected
      initGitRepo(harness);

      // '\r' selects project scope, '\r' accepts 'Install pre-commit code scanning hook?',
      // dep-risks is auto-skipped (no project key), 'n' declines 'Install pre-push code scanning hook?'.
      const result = await harness.run('integrate git', {
        stdinChunks: ['\r', '\r', 'n'],
        stdinChunkDelayMs: PROJECT_PROMPT_CHUNK_DELAY_MS,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('✓  pre-commit code scanning hook');
      expect(harness.cwd.exists('.git', 'hooks', 'pre-commit')).toBe(true);
      expect(harness.cwd.exists('.git', 'hooks', 'pre-push')).toBe(false);
    },
    { timeout: 15000 },
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
      expect(harness.cwd.exists('.git', 'hooks', 'pre-commit')).toBe(true);
      expect(harness.cwd.exists('.git', 'hooks', 'pre-push')).toBe(true);

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
    'records project hook installation in state',
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
        scope: 'project',
        targetRoot: harness.cwd.path,
      });
      expectSubfeatureHasDependency(feature, 'pre-commit-secrets', 'sonar-secrets');
      expectInstalledResource(feature, 'hook-file', 'whole-file');
      expect(feature.operations).toEqual([]);
      expectInstalledDependency(state, 'sonar-secrets', 'sonarsource-binary');
    },
    { timeout: 15000 },
  );

  it(
    'installs native pre-push hook via interactive prompts when secrets is already installed',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      // '\r' selects project scope, 'n' declines the 'Install pre-commit code scanning hook?'
      // prompt, '\r' accepts 'Install pre-push code scanning hook?'.
      const result = await harness.run('integrate git', {
        stdinChunks: ['\r', 'n', '\r'],
        stdinChunkDelayMs: PROJECT_PROMPT_CHUNK_DELAY_MS,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('✓  pre-push code scanning hook');
      expect(harness.cwd.exists('.git', 'hooks', 'pre-push')).toBe(true);
      expect(harness.cwd.exists('.git', 'hooks', 'pre-commit')).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'installs both native hooks when the user accepts each per-feature prompt',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      // '\r' selects project scope, '\r' accepts 'Install pre-commit code scanning hook?',
      // dep-risks is auto-skipped (no project key), '\r' accepts 'Install pre-push code scanning hook?'.
      const result = await harness.run('integrate git', {
        stdinChunks: ['\r', '\r', '\r'],
        stdinChunkDelayMs: PROJECT_PROMPT_CHUNK_DELAY_MS,
      });

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Install pre-commit code scanning hook?');
      expect(output).toContain('Install pre-push code scanning hook?');
      expect(harness.cwd.exists('.git', 'hooks', 'pre-commit')).toBe(true);
      expect(harness.cwd.exists('.git', 'hooks', 'pre-push')).toBe(true);

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      const featureIds = gitIntegration.features
        .map((feature) => feature.featureId)
        .sort((a, b) => a.localeCompare(b));
      expect(featureIds).toEqual(['pre-commit-hook', 'pre-push-hook']);
      for (const feature of gitIntegration.features) {
        expect(feature.attrs).toEqual({ projectKey: null });
      }
    },
    { timeout: 15000 },
  );

  it(
    'prompts for dep-risks and bakes it in when user accepts with project key provided',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true, scaEnabled: true });
      harness.state().withScaScannerBinaryInstalled();
      initGitRepo(harness);

      // -p implies project scope (no scope prompt). '\r' accepts 'Enable dependency-risks scanning?'.
      // Pre-commit is forced by --hook; pre-push is skipped. Dep-risks prompt appears
      // because -p supplies a project key.
      const result = await harness.run('integrate git --hook pre-commit -p my-project', {
        stdinChunks: ['\r'],
        stdinChunkDelayMs: PROJECT_PROMPT_CHUNK_DELAY_MS,
      });

      expect(result.exitCode).toBe(0);
      const hookContent = readFileSync(
        join(harness.cwd.path, '.git', 'hooks', 'pre-commit'),
        'utf-8',
      );
      expect(hookContent).toContain('--dependency-risks -p');
      expect(hookContent).toContain('my-project');

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      const feature = gitIntegration.features[0];
      expect(feature.attrs).toMatchObject({ projectKey: 'my-project' });
      expectSubfeatureHasDependency(feature, 'pre-commit-secrets', 'sonar-secrets');
      expectSubfeatureHasDependency(feature, 'pre-commit-dependency-risks', 'sca-scanner-cli');
    },
    { timeout: 15000 },
  );

  it(
    'prompts for dep-risks and omits it when user declines with project key provided',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true, scaEnabled: true });
      initGitRepo(harness);

      // -p implies project scope (no scope prompt). 'n' declines 'Enable dependency-risks scanning?'.
      const result = await harness.run('integrate git --hook pre-commit -p my-project', {
        stdinChunks: ['n'],
        stdinChunkDelayMs: PROJECT_PROMPT_CHUNK_DELAY_MS,
      });

      expect(result.exitCode).toBe(0);
      const hookContent = readFileSync(
        join(harness.cwd.path, '.git', 'hooks', 'pre-commit'),
        'utf-8',
      );
      expect(hookContent).not.toContain('--dependency-risks');

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      const feature = gitIntegration.features[0];
      expect(feature.attrs).toMatchObject({ projectKey: 'my-project' });
      expectSubfeatureHasDependency(feature, 'pre-commit-secrets', 'sonar-secrets');
      expect(
        feature.subfeatures?.find((s) => s.featureId === 'pre-commit-dependency-risks'),
      ).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'skips dep-risks prompt when SCA is not enabled on the server',
    async () => {
      // No scaEnabled: true → fake server returns 404 for the SCA endpoint → check_failed → skip.
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      // Only '\r' needed: scope prompt. Dep-risks prompt is suppressed because SCA is unavailable.
      const result = await harness.run('integrate git --hook pre-commit -p my-project', {
        stdinChunks: ['\r'],
        stdinChunkDelayMs: PROJECT_PROMPT_CHUNK_DELAY_MS,
      });

      expect(result.exitCode).toBe(0);
      const hookContent = readFileSync(
        join(harness.cwd.path, '.git', 'hooks', 'pre-commit'),
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
    'skips dep-risks and prints a message when --dependency-risks is set but SCA is not enabled',
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
      initGitRepo(harness);

      const result = await harness.run(
        'integrate git --hook pre-commit --dependency-risks -p my-project --non-interactive',
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'Software Composition Analysis is not available for the current connection.',
      );
      const hookContent = readFileSync(
        join(harness.cwd.path, '.git', 'hooks', 'pre-commit'),
        'utf-8',
      );
      expect(hookContent).not.toContain('--dependency-risks');
    },
    { timeout: 15000 },
  );

  it(
    'opts into dependency-risks interactively and auto-discovers project key',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true, scaEnabled: true });
      harness.state().withScaScannerBinaryInstalled();
      initGitRepo(harness);
      harness.cwd.writeFile('sonar-project.properties', 'sonar.projectKey=auto-project\n');

      // '\r' selects project scope, '\r' accepts 'Install pre-commit hook?',
      // '\r' accepts 'Enable dependency-risks?' (dep-risks is a pre-commit subfeature,
      // so it prompts immediately after pre-commit is accepted), 'n' declines
      // 'Install pre-push hook?'. Project key discovered from sonar-project.properties.
      const result = await harness.run('integrate git', {
        stdinChunks: ['\r', '\r', '\r', 'n'],
        stdinChunkDelayMs: PROJECT_PROMPT_CHUNK_DELAY_MS,
      });

      expect(result.exitCode).toBe(0);
      const hookContent = readFileSync(
        join(harness.cwd.path, '.git', 'hooks', 'pre-commit'),
        'utf-8',
      );
      expect(hookContent).toContain('--dependency-risks -p');
      expect(hookContent).toContain('auto-project');

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      const feature = gitIntegration.features[0];
      expect(feature.featureId).toBe('pre-commit-hook');
      expect(feature.attrs?.projectKey).toBe('auto-project');
      expectSubfeatureHasDependency(feature, 'pre-commit-secrets', 'sonar-secrets');
      expectSubfeatureHasDependency(feature, 'pre-commit-dependency-risks', 'sca-scanner-cli');
      expectInstalledDependency(state, 'sonar-secrets', 'sonarsource-binary');
      expectInstalledDependency(state, 'sca-scanner-cli', 'sonarsource-binary');
    },
    { timeout: 30000 },
  );

  it(
    'fails with an explicit notice when the user declines every per-feature prompt',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      // '\r' selects project scope, then 'n' declines both the
      // 'Install pre-commit code scanning hook?' and 'Install pre-push code scanning hook?' prompts.
      const result = await harness.run('integrate git', {
        stdinChunks: ['\r', 'n', 'n'],
        stdinChunkDelayMs: PROJECT_PROMPT_CHUNK_DELAY_MS,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'No feature selected for Native Git integration',
      );
      expect(harness.cwd.exists('.git', 'hooks', 'pre-commit')).toBe(false);
      expect(harness.cwd.exists('.git', 'hooks', 'pre-push')).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'installs native global pre-commit hook via interactive prompts when secrets is already installed',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      // Per-feature confirm flow: '\r' confirms the global hook warning, '\r' accepts
      // 'Install pre-commit code scanning hook?', 'n' declines 'Install pre-push code scanning hook?'.
      const result = await harness.run('integrate git --global', {
        stdinChunks: ['\r', '\r', 'n'],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('✓  pre-commit code scanning hook');
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit')).toBe(true);
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-push')).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'records global hook installation in state',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      const result = await harness.run('integrate git --global --hook pre-push --non-interactive');

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

      // Per-feature confirm flow: '\r' confirms the global hook warning, 'n' declines
      // 'Install pre-commit code scanning hook?', '\r' accepts 'Install pre-push code scanning hook?'.
      const result = await harness.run('integrate git --global', {
        stdinChunks: ['\r', 'n', '\r'],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('✓  pre-push code scanning hook');
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-push')).toBe(true);
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit')).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'exits with error when --dependency-risks is used without -p',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      const result = await harness.run(
        'integrate git --hook pre-commit --dependency-risks --non-interactive',
      );

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('--dependency-risks requires -p');
    },
    { timeout: 15000 },
  );

  it(
    'exits with error when --global is combined with --dependency-risks',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      const result = await harness.run(
        'integrate git --global --dependency-risks -p my-project --non-interactive',
      );

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain(
        '--dependency-risks and -p are not supported with --global',
      );
    },
    { timeout: 15000 },
  );

  it(
    'bakes the project key into the native pre-commit hook when --dependency-risks is set',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true, scaEnabled: true });
      harness.state().withScaScannerBinaryInstalled();
      initGitRepo(harness);

      const result = await harness.run(
        'integrate git --hook pre-commit --dependency-risks -p my-project --non-interactive',
      );

      expect(result.exitCode).toBe(0);

      const hookContent = readFileSync(
        join(harness.cwd.path, '.git', 'hooks', 'pre-commit'),
        'utf-8',
      );
      expect(hookContent).toContain('--dependency-risks -p');
      expect(hookContent).toContain('my-project');

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const gitIntegration = getInstalledIntegration(state, 'native-git');
      const feature = gitIntegration.features[0];
      expect(feature.featureId).toBe('pre-commit-hook');
      expectSubfeatureHasDependency(feature, 'pre-commit-secrets', 'sonar-secrets');
      expectSubfeatureHasDependency(feature, 'pre-commit-dependency-risks', 'sca-scanner-cli');
      expectInstalledDependency(state, 'sonar-secrets', 'sonarsource-binary');
      expectInstalledDependency(state, 'sca-scanner-cli', 'sonarsource-binary');
    },
    { timeout: 15000 },
  );

  it(
    '--dependency-risks with --hook pre-push is rejected',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      const result = await harness.run(
        'integrate git --hook pre-push --dependency-risks -p my-project --non-interactive',
      );

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

describe('integrate git (husky)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'installs and records pre-commit hook via husky when core.hooksPath is .husky',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepoWithHusky(harness);

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'Installing pre-commit code scanning hook...',
      );
      expect(result.stdout + result.stderr).toContain('✓  pre-commit code scanning hook');
      expect(harness.cwd.exists('.husky', 'pre-commit')).toBe(true);
      const hookContent = readFileSync(join(harness.cwd.path, '.husky', 'pre-commit'), 'utf-8');
      expect(hookContent).toContain('hook git-pre-commit');

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const huskyIntegration = getInstalledIntegration(state, 'husky');
      expect(huskyIntegration.features).toHaveLength(1);
      const feature = huskyIntegration.features[0];
      expect(feature).toMatchObject({
        featureId: 'pre-commit-hook',
        scope: 'project',
        targetRoot: harness.cwd.path,
      });
      expectSubfeatureHasDependency(feature, 'pre-commit-secrets', 'sonar-secrets');
      expectInstalledResource(feature, 'hook-file', 'text-snippet');
      expect(feature.operations).toEqual([]);
      expectInstalledDependency(state, 'sonar-secrets', 'sonarsource-binary');
    },
    { timeout: 15000 },
  );

  it(
    'replaces a legacy husky pre-commit fragment when the integration is run again',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepoWithHusky(harness);
      harness.cwd.writeFile(
        '.husky/pre-commit',
        [
          '#!/bin/sh',
          '# Sonar secrets scan - installed by sonar integrate git',
          String.raw`CLEAN_PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':' | sed 's/:$//')`,
          `SONAR_BIN=$(PATH=$CLEAN_PATH command -v sonar 2>/dev/null || :)`,
          '[ -z "$SONAR_BIN" ] && { echo "sonarqube-cli not found, skipping secrets scan"; exit 0; }',
          '"$SONAR_BIN" hook git-pre-commit',
          '',
        ].join('\n'),
      );

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      const hookContent = readFileSync(join(harness.cwd.path, '.husky', 'pre-commit'), 'utf-8');
      // The legacy secrets-specific marker is migrated away; the normalized begin/end pair replaces it.
      expect(
        countOccurrences(hookContent, '# Sonar secrets scan - installed by sonar integrate git'),
      ).toBe(0);
      expect(countOccurrences(hookContent, '# sonar:begin husky-pre-commit')).toBe(1);
      expect(countOccurrences(hookContent, 'hook git-pre-commit')).toBe(1);
      expect(hookContent).toContain('# sonar:end husky-pre-commit');
    },
    { timeout: 15000 },
  );

  it(
    'installs and records pre-push hook via husky when core.hooksPath is .husky',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepoWithHusky(harness);

      const result = await harness.run('integrate git --hook pre-push --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Installing pre-push code scanning hook...');
      expect(result.stdout + result.stderr).toContain('✓  pre-push code scanning hook');
      expect(harness.cwd.exists('.husky', 'pre-push')).toBe(true);
      const hookContent = readFileSync(join(harness.cwd.path, '.husky', 'pre-push'), 'utf-8');
      expect(hookContent).toContain('hook git-pre-push');

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const huskyIntegration = getInstalledIntegration(state, 'husky');
      expect(huskyIntegration.features).toHaveLength(1);
      const feature = huskyIntegration.features[0];
      expect(feature).toMatchObject({
        featureId: 'pre-push-hook',
        scope: 'project',
        targetRoot: harness.cwd.path,
      });
      expectFeatureDependency(feature, 'sonar-secrets');
      expectInstalledResource(feature, 'hook-file', 'text-snippet');
      expect(feature.operations).toEqual([]);
      expectInstalledDependency(state, 'sonar-secrets', 'sonarsource-binary');
    },
    { timeout: 15000 },
  );

  it(
    'bakes the project key into the husky pre-commit hook when --dependency-risks is set',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true, scaEnabled: true });
      harness.state().withScaScannerBinaryInstalled();
      initGitRepoWithHusky(harness);

      const result = await harness.run(
        'integrate git --hook pre-commit --dependency-risks -p my-project --non-interactive',
      );

      expect(result.exitCode).toBe(0);

      const hookContent = readFileSync(join(harness.cwd.path, '.husky', 'pre-commit'), 'utf-8');
      expect(hookContent).toContain('--dependency-risks -p');
      expect(hookContent).toContain('my-project');

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const huskyIntegration = getInstalledIntegration(state, 'husky');
      const feature = huskyIntegration.features[0];
      expect(feature.featureId).toBe('pre-commit-hook');
      expectSubfeatureHasDependency(feature, 'pre-commit-secrets', 'sonar-secrets');
      expectSubfeatureHasDependency(feature, 'pre-commit-dependency-risks', 'sca-scanner-cli');
      expectInstalledDependency(state, 'sca-scanner-cli', 'sonarsource-binary');
    },
    { timeout: 15000 },
  );
});

describe('integrate git (pre-commit framework)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function setupFakePreCommit(logPath: string): Record<string, string> {
    // Create a fake pre-commit binary that always exits 0 so tests pass even when
    // the real pre-commit framework is not installed (e.g. in CI environments).
    const fakeBinDir = join(harness.cwd.path, 'fake-bin');
    mkdirSync(fakeBinDir, { recursive: true });
    if (IS_WINDOWS) {
      writeFileSync(
        join(fakeBinDir, 'pre-commit.cmd'),
        '@echo off\r\nif not "%PRE_COMMIT_LOG%"=="" echo %*>>"%PRE_COMMIT_LOG%"\r\n@exit /b 0\r\n',
      );
    } else {
      writeFileSync(
        join(fakeBinDir, 'pre-commit'),
        '#!/bin/sh\nif [ -n "$PRE_COMMIT_LOG" ]; then\n  printf \'%s\\n\' "$*" >> "$PRE_COMMIT_LOG"\nfi\nexit 0\n',
        { mode: 0o755 },
      );
    }
    return {
      PATH: `${fakeBinDir}${PATH_DELIM}${process.env.PATH ?? ''}`,
      PRE_COMMIT_LOG: logPath,
    };
  }

  it(
    'updates config, activates pre-commit, and records state for the pre-commit framework',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepoWithPreCommitConfig(harness);
      const preCommitLog = join(harness.cwd.path, 'pre-commit.log');
      harness.cwd.writeFile(
        '.pre-commit-config.yaml',
        yaml.dump({
          repos: [
            {
              repo: LEGACY_PRE_COMMIT_REPO,
              rev: 'v2.41.0.10709',
              hooks: [{ id: 'sonar-secrets', stages: ['pre-commit'] }],
            },
            {
              repo: 'local',
              hooks: [{ id: 'other-local-hook', stages: ['manual'] }],
            },
          ],
        }),
      );

      const result = await harness.run('integrate git --hook pre-commit --non-interactive', {
        extraEnv: setupFakePreCommit(preCommitLog),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'Installing pre-commit code scanning hook...',
      );
      expect(result.stdout + result.stderr).toContain('✓  pre-commit code scanning hook');

      const config = readYamlFile<PreCommitYamlConfig>(
        join(harness.cwd.path, '.pre-commit-config.yaml'),
      );
      expect(config.repos.some((repo) => repo.repo === LEGACY_PRE_COMMIT_REPO)).toBe(false);
      const localRepo = config.repos.find((repo) => repo.repo === 'local');
      expect(localRepo?.hooks.some((hook) => hook.id === 'other-local-hook')).toBe(true);
      const sonarHook = localRepo?.hooks.find((hook) => hook.id === 'sonar-pre-commit');
      expect(sonarHook?.stages).toEqual(['pre-commit']);
      expect(readCommandLog(preCommitLog)).toEqual(['uninstall', 'clean', 'install']);

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const preCommitIntegration = getInstalledIntegration(state, 'pre-commit');
      expect(preCommitIntegration.features).toHaveLength(1);
      const feature = preCommitIntegration.features[0];
      expect(feature).toMatchObject({
        featureId: 'pre-commit-hook',
        scope: 'project',
        targetRoot: harness.cwd.path,
      });
      expectSubfeatureHasDependency(feature, 'pre-commit-secrets', 'sonar-secrets');
      expectInstalledResource(feature, 'hook-config', 'yaml-patch');
      expectInstalledOperation(feature, 'activate-hook');
      expectInstalledDependency(state, 'sonar-secrets', 'sonarsource-binary');
    },
    { timeout: 15000 },
  );

  it(
    'updates config, activates pre-push, and records state for the pre-commit framework',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepoWithPreCommitConfig(harness);
      const preCommitLog = join(harness.cwd.path, 'pre-commit.log');

      const result = await harness.run('integrate git --hook pre-push --non-interactive', {
        extraEnv: setupFakePreCommit(preCommitLog),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Installing pre-push code scanning hook...');
      expect(result.stdout + result.stderr).toContain('✓  pre-push code scanning hook');

      const config = readYamlFile<PreCommitYamlConfig>(
        join(harness.cwd.path, '.pre-commit-config.yaml'),
      );
      const localRepo = config.repos.find((repo) => repo.repo === 'local');
      const sonarHook = localRepo?.hooks.find((hook) => hook.id === 'sonar-pre-push');
      expect(sonarHook?.stages).toEqual(['pre-push']);
      expect(sonarHook?.entry).toBe('sonar hook git-pre-push --');
      expect(sonarHook?.pass_filenames).toBe(true);
      expect(readCommandLog(preCommitLog)).toEqual([
        'uninstall',
        'clean',
        'install',
        'install --hook-type pre-push',
      ]);

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const preCommitIntegration = getInstalledIntegration(state, 'pre-commit');
      expect(preCommitIntegration.features).toHaveLength(1);
      const feature = preCommitIntegration.features[0];
      expect(feature).toMatchObject({
        featureId: 'pre-push-hook',
        scope: 'project',
        targetRoot: harness.cwd.path,
      });
      expectFeatureDependency(feature, 'sonar-secrets');
      expectInstalledResource(feature, 'hook-config', 'yaml-patch');
      expectInstalledOperation(feature, 'activate-hook');
      expectInstalledDependency(state, 'sonar-secrets', 'sonarsource-binary');
    },
    { timeout: 15000 },
  );

  it(
    'running the pre-commit framework integration twice keeps a single sonar hook entry',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepoWithPreCommitConfig(harness);
      const preCommitLog = join(harness.cwd.path, 'pre-commit.log');
      harness.cwd.writeFile(
        '.pre-commit-config.yaml',
        yaml.dump({
          repos: [
            {
              repo: 'local',
              hooks: [{ id: 'other-local-hook', stages: ['manual'] }],
            },
          ],
        }),
      );

      const extraEnv = setupFakePreCommit(preCommitLog);
      const first = await harness.run('integrate git --hook pre-commit --non-interactive', {
        extraEnv,
      });
      const second = await harness.run('integrate git --hook pre-commit --non-interactive', {
        extraEnv,
      });

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);

      const config = readYamlFile<PreCommitYamlConfig>(
        join(harness.cwd.path, '.pre-commit-config.yaml'),
      );
      const localRepo = config.repos.find((repo) => repo.repo === 'local');
      expect(localRepo).toBeDefined();
      expect(localRepo?.hooks.some((hook) => hook.id === 'other-local-hook')).toBe(true);

      const sonarHooks = localRepo?.hooks.filter((hook) => hook.id === 'sonar-pre-commit');
      expect(sonarHooks).toHaveLength(1);
      expect(sonarHooks?.[0].stages).toEqual(['pre-commit']);

      expect(readCommandLog(preCommitLog)).toEqual([
        'uninstall',
        'clean',
        'install',
        'uninstall',
        'clean',
        'install',
      ]);

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const preCommitIntegration = getInstalledIntegration(state, 'pre-commit');
      expect(preCommitIntegration.features).toHaveLength(1);
      expect(preCommitIntegration.features[0]).toMatchObject({
        featureId: 'pre-commit-hook',
        scope: 'project',
        targetRoot: harness.cwd.path,
      });
    },
    { timeout: 15000 },
  );

  it(
    'keeps both the pre-commit and pre-push hooks when each stage is installed',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepoWithPreCommitConfig(harness);
      const preCommitLog = join(harness.cwd.path, 'pre-commit.log');
      const extraEnv = setupFakePreCommit(preCommitLog);

      const first = await harness.run('integrate git --hook pre-commit --non-interactive', {
        extraEnv,
      });
      const second = await harness.run('integrate git --hook pre-push --non-interactive', {
        extraEnv,
      });

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);

      const config = readYamlFile<PreCommitYamlConfig>(
        join(harness.cwd.path, '.pre-commit-config.yaml'),
      );
      const localRepo = config.repos.find((repo) => repo.repo === 'local');
      const ids = localRepo?.hooks.map((hook) => hook.id) ?? [];
      expect(ids.filter((id) => id === 'sonar-pre-commit')).toHaveLength(1);
      expect(ids.filter((id) => id === 'sonar-pre-push')).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'migrates legacy sonar-secrets entries to per-stage ids one stage at a time',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepoWithPreCommitConfig(harness);
      const preCommitLog = join(harness.cwd.path, 'pre-commit.log');
      harness.cwd.writeFile(
        '.pre-commit-config.yaml',
        yaml.dump({
          repos: [
            {
              repo: 'local',
              hooks: [
                {
                  id: 'sonar-secrets',
                  name: 'Sonar pre-commit scan',
                  entry: 'sonar hook git-pre-commit --',
                  language: 'system',
                  pass_filenames: true,
                  stages: ['pre-commit'],
                },
                {
                  id: 'sonar-secrets',
                  name: 'Sonar pre-push scan',
                  entry: 'sonar hook git-pre-push --',
                  language: 'system',
                  pass_filenames: true,
                  stages: ['pre-push'],
                },
              ],
            },
          ],
        }),
      );

      const extraEnv = setupFakePreCommit(preCommitLog);

      // Running pre-commit migrates only that stage; the pre-push legacy entry is left intact.
      const first = await harness.run('integrate git --hook pre-commit --non-interactive', {
        extraEnv,
      });
      expect(first.exitCode).toBe(0);

      const midConfig = readYamlFile<PreCommitYamlConfig>(
        join(harness.cwd.path, '.pre-commit-config.yaml'),
      );
      const midLocal = midConfig.repos.find((repo) => repo.repo === 'local');
      expect(midLocal?.hooks.find((h) => h.id === 'sonar-pre-commit')?.stages).toEqual([
        'pre-commit',
      ]);
      expect(
        midLocal?.hooks.some((h) => h.id === 'sonar-secrets' && h.stages?.includes('pre-push')),
      ).toBe(true);

      // Running pre-push migrates that stage too; no legacy entries remain.
      const second = await harness.run('integrate git --hook pre-push --non-interactive', {
        extraEnv,
      });
      expect(second.exitCode).toBe(0);

      const finalConfig = readYamlFile<PreCommitYamlConfig>(
        join(harness.cwd.path, '.pre-commit-config.yaml'),
      );
      const finalLocal = finalConfig.repos.find((repo) => repo.repo === 'local');
      const ids = finalLocal?.hooks.map((h) => h.id) ?? [];
      expect(ids.filter((id) => id === 'sonar-pre-commit')).toHaveLength(1);
      expect(ids.filter((id) => id === 'sonar-pre-push')).toHaveLength(1);
      expect(ids.includes('sonar-secrets')).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'bakes the project key into the pre-commit config hook entry when --dependency-risks is set',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true, scaEnabled: true });
      harness.state().withScaScannerBinaryInstalled();
      initGitRepoWithPreCommitConfig(harness);
      const preCommitLog = join(harness.cwd.path, 'pre-commit.log');

      const result = await harness.run(
        'integrate git --hook pre-commit --dependency-risks -p my-project --non-interactive',
        { extraEnv: setupFakePreCommit(preCommitLog) },
      );

      expect(result.exitCode).toBe(0);

      const config = readYamlFile<PreCommitYamlConfig>(
        join(harness.cwd.path, '.pre-commit-config.yaml'),
      );
      const localRepo = config.repos.find((repo) => repo.repo === 'local');
      const sonarHook = localRepo?.hooks.find((hook) => hook.id === 'sonar-pre-commit');
      expect(sonarHook?.entry).toContain('--dependency-risks');
      expect(sonarHook?.entry).toContain('-p my-project');

      const state = harness.stateJsonFile.asJson() as InstalledStateJson;
      const preCommitIntegration = getInstalledIntegration(state, 'pre-commit');
      const feature = preCommitIntegration.features[0];
      expect(feature.featureId).toBe('pre-commit-hook');
      expectSubfeatureHasDependency(feature, 'pre-commit-secrets', 'sonar-secrets');
      expectSubfeatureHasDependency(feature, 'pre-commit-dependency-risks', 'sca-scanner-cli');
      expectInstalledDependency(state, 'sca-scanner-cli', 'sonarsource-binary');
    },
    { timeout: 15000 },
  );
});
