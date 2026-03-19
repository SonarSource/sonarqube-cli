/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestHarness } from '../../harness';
import { getCliBinaryPath } from '../../harness/cli-runner.js';

const PATH_DELIM = process.platform === 'win32' ? ';' : ':';
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
  const homeEnv: Record<string, string> =
    process.platform === 'win32'
      ? { USERPROFILE: harness.userHome.path }
      : { HOME: harness.userHome.path };

  return {
    ...process.env,
    ...homeEnv,
    SONAR_CLI_KEYCHAIN_FILE: harness.keychainJsonFile.path,
    PATH: `${sonarBinDir}${PATH_DELIM}${pathWithoutNodeModules(process.env.PATH)}`,
  };
}

function setupSonarBinDir(harness: TestHarness): {
  sonarBinDir: string;
  hookEnv: Record<string, string>;
} {
  const sonarBinDir = join(harness.cwd.path, 'sonar-bin');
  mkdirSync(sonarBinDir, { recursive: true });
  symlinkSync(getCliBinaryPath(), join(sonarBinDir, 'sonar'));
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
      expect(output).toContain('Secrets found');
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
      expect(output).toContain('Secrets found');
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
      expect(result.stdout + result.stderr).toContain('pre-commit hook installed');
      expect(harness.cwd.exists('.git', 'hooks', 'pre-commit')).toBe(true);
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
      expect(result.stdout + result.stderr).toContain('pre-push hook installed');
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
      expect(result.stdout + result.stderr).toContain('pre-commit hook installed globally');
      expect(harness.userHome.exists('.sonar', 'sonarqube-cli', 'hooks', 'pre-commit')).toBe(true);
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
      expect(result.stdout + result.stderr).toContain('pre-push hook installed globally');
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
    'installs pre-commit hook via husky when core.hooksPath is .husky',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepoWithHusky(harness);

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'pre-commit hook installed (Husky detected: added to .husky/pre-commit).',
      );
      expect(harness.cwd.exists('.husky', 'pre-commit')).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'installs pre-push hook via husky when core.hooksPath is .husky',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepoWithHusky(harness);

      const result = await harness.run('integrate git --hook pre-push --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'pre-push hook installed (Husky detected: added to .husky/pre-push).',
      );
      expect(harness.cwd.exists('.husky', 'pre-push')).toBe(true);
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

  function setupFakePreCommit(): string {
    // Create a fake pre-commit binary that always exits 0 so tests pass even when
    // the real pre-commit framework is not installed (e.g. in CI environments).
    const fakeBinDir = join(harness.cwd.path, 'fake-bin');
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(join(fakeBinDir, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return `${fakeBinDir}:${process.env.PATH ?? ''}`;
  }

  it(
    'installs pre-commit hook via pre-commit framework when .pre-commit-config.yaml exists',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepoWithPreCommitConfig(harness);

      const result = await harness.run('integrate git --hook pre-commit --non-interactive', {
        extraEnv: { PATH: setupFakePreCommit() },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'pre-commit hook installed (pre-commit framework: added to .pre-commit-config.yaml).',
      );
    },
    { timeout: 15000 },
  );

  it(
    'installs pre-push hook via pre-commit framework when .pre-commit-config.yaml exists',
    async () => {
      await setupAuthenticated(harness, { withSecretsBinary: true });
      initGitRepoWithPreCommitConfig(harness);

      const result = await harness.run('integrate git --hook pre-push --non-interactive', {
        extraEnv: { PATH: setupFakePreCommit() },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'pre-push hook installed (pre-commit framework: added to .pre-commit-config.yaml).',
      );
    },
    { timeout: 15000 },
  );
});
