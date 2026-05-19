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
  return env;
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

type InstalledStateJson = {
  integrations: {
    installed: Array<{
      integrationId: string;
      features: Array<{
        featureId: string;
        scope: string;
        targetRoot: string;
        attrs?: Record<string, unknown>;
        resources: Array<{ id: string; resourceType: string }>;
        operations: Array<{ id: string }>;
      }>;
    }>;
  };
};

type InstalledIntegrationJson = InstalledStateJson['integrations']['installed'][number];
type InstalledFeatureJson = InstalledIntegrationJson['features'][number];

type PreCommitYamlConfig = {
  repos: Array<{
    repo: string;
    hooks: Array<{ id: string; stages?: string[] }>;
  }>;
};

function getInstalledIntegration(state: InstalledStateJson, integrationId: string) {
  const integration = state.integrations.installed.find(
    (entry) => entry.integrationId === integrationId,
  );
  expect(integration).toBeDefined();
  return integration as InstalledIntegrationJson;
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

type SetupAuthOptions = { withSecretsBinary?: boolean };

async function setupAuthenticated(
  harness: TestHarness,
  options: SetupAuthOptions = {},
): Promise<void> {
  const server = await harness.newFakeServer().withAuthToken(INTEGRATION_TEST_TOKEN).start();
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
    'exits with error when user cancels the hook-type selection',
    async () => {
      await setupAuthenticated(harness);

      // Minimal git repo: findGitRoot() detects the .git directory
      harness.cwd.writeFile('.git/.keep', '');

      // Ctrl+C sent to stdin cancels the interactive confirmPrompt
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

      // Two separate stdin chunks with a delay between them so readline doesn't buffer
      // both at once: 'y' confirms 'Install here?', then '\r' selects pre-commit
      const result = await harness.run('integrate git', { stdinChunks: ['y', '\r'] });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Installed pre-commit hook');
      expect(harness.cwd.exists('.git', 'hooks', 'pre-commit')).toBe(true);
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
        attrs: {
          hook: 'pre-commit',
        },
      });
      expectInstalledResource(feature, 'sonar-secrets', 'sonarsource-binary');
      expectInstalledResource(feature, 'hook-file', 'git-hook-file');
      expect(feature.operations).toEqual([]);
    },
    { timeout: 15000 },
  );

  it(
    'installs native pre-push hook via interactive prompts when secrets is already installed',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepo(harness);

      // 'y' confirms 'Install here?'; '\x1b[B' moves the selection down to pre-push; '\r' submits
      const result = await harness.run('integrate git', {
        stdinChunks: ['y', '\x1b[B', '\r'],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Installed pre-push hook');
      expect(harness.cwd.exists('.git', 'hooks', 'pre-push')).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'installs native global pre-commit hook via interactive prompts when secrets is already installed',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      // Two separate stdin chunks with a delay between them so readline doesn't buffer
      // both at once: 'y' confirms global hook warning, then '\r' selects pre-commit
      const result = await harness.run('integrate git --global', { stdinChunks: ['y', '\r'] });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Installed pre-commit hook');
      expect(result.stdout + result.stderr).toContain('Applied global hooks path');
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit')).toBe(true);
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
        attrs: {
          hook: 'pre-push',
        },
      });
      expectInstalledOperation(feature, 'configure-global-hooks-path');
    },
    { timeout: 15000 },
  );

  it(
    'installs native global pre-push hook via interactive prompts when secrets is already installed',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });

      // Two separate stdin chunks with a delay between them so readline doesn't buffer
      // both at once: 'y' confirms global hook warning, then '\r' selects pre-push
      const result = await harness.run('integrate git --global', {
        stdinChunks: ['y', '\x1b[B', '\r'],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Installed pre-push hook');
      expect(result.stdout + result.stderr).toContain('Applied global hooks path');
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-push')).toBe(true);
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
        'Installing Husky integration: pre-commit hook',
      );
      expect(result.stdout + result.stderr).toContain('Installed pre-commit hook');
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
        attrs: {
          hook: 'pre-commit',
        },
      });
      expectInstalledResource(feature, 'sonar-secrets', 'sonarsource-binary');
      expectInstalledResource(feature, 'hook-file', 'text-snippet');
      expect(feature.operations).toEqual([]);
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
          `CLEAN_PATH=$(echo "$PATH" | tr ':' '\\n' | grep -v node_modules | tr '\\n' ':' | sed 's/:$//')`,
          `SONAR_BIN=$(PATH=$CLEAN_PATH command -v sonar 2>/dev/null || :)`,
          '[ -z "$SONAR_BIN" ] && { echo "sonarqube-cli not found, skipping secrets scan"; exit 0; }',
          '"$SONAR_BIN" hook git-pre-commit',
          '',
        ].join('\n'),
      );

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      const hookContent = readFileSync(join(harness.cwd.path, '.husky', 'pre-commit'), 'utf-8');
      expect(
        countOccurrences(hookContent, '# Sonar secrets scan - installed by sonar integrate git'),
      ).toBe(1);
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
      expect(result.stdout + result.stderr).toContain(
        'Installing Husky integration: pre-push hook',
      );
      expect(result.stdout + result.stderr).toContain('Installed pre-push hook');
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
        attrs: {
          hook: 'pre-push',
        },
      });
      expectInstalledResource(feature, 'sonar-secrets', 'sonarsource-binary');
      expectInstalledResource(feature, 'hook-file', 'text-snippet');
      expect(feature.operations).toEqual([]);
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
        'Installing pre-commit integration: pre-commit hook',
      );
      expect(result.stdout + result.stderr).toContain('Installed pre-commit hook');

      const config = readYamlFile<PreCommitYamlConfig>(
        join(harness.cwd.path, '.pre-commit-config.yaml'),
      );
      expect(config.repos.some((repo) => repo.repo === LEGACY_PRE_COMMIT_REPO)).toBe(false);
      const localRepo = config.repos.find((repo) => repo.repo === 'local');
      expect(localRepo?.hooks.some((hook) => hook.id === 'other-local-hook')).toBe(true);
      const sonarHook = localRepo?.hooks.find((hook) => hook.id === 'sonar-secrets');
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
        attrs: {
          hook: 'pre-commit',
        },
      });
      expectInstalledResource(feature, 'sonar-secrets', 'sonarsource-binary');
      expectInstalledResource(feature, 'hook-config', 'yaml-patch');
      expectInstalledOperation(feature, 'activate-hook');
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
      expect(result.stdout + result.stderr).toContain(
        'Installing pre-commit integration: pre-push hook',
      );
      expect(result.stdout + result.stderr).toContain('Installed pre-push hook');

      const config = readYamlFile<PreCommitYamlConfig>(
        join(harness.cwd.path, '.pre-commit-config.yaml'),
      );
      const localRepo = config.repos.find((repo) => repo.repo === 'local');
      const sonarHook = localRepo?.hooks.find((hook) => hook.id === 'sonar-secrets');
      expect(sonarHook?.stages).toEqual(['pre-push']);
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
        attrs: {
          hook: 'pre-push',
        },
      });
      expectInstalledResource(feature, 'sonar-secrets', 'sonarsource-binary');
      expectInstalledResource(feature, 'hook-config', 'yaml-patch');
      expectInstalledOperation(feature, 'activate-hook');
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

      const sonarHooks = localRepo?.hooks.filter((hook) => hook.id === 'sonar-secrets');
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
        attrs: {
          hook: 'pre-commit',
        },
      });
    },
    { timeout: 15000 },
  );
});
