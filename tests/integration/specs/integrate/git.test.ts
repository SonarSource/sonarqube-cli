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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestHarness } from '../../harness';

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
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token');

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
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token');

      // No .git directory — discoverProject() sets isGitRepo: false
      const result = await harness.run('integrate git --non-interactive');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('No git repository found');
    },
    { timeout: 15000 },
  );

  it(
    'installs pre-commit hook when user selects pre-commit (--non-interactive)',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token');

      // Minimal git repo
      harness.cwd.writeFile('.git/.keep', '');

      // Fake binaries server so that ensureSonarSecrets() can download sonar-secrets
      await harness.newFakeBinariesServer().start();

      const result = await harness.run('integrate git --hook pre-commit --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists('.git', 'hooks', 'pre-commit')).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'installs native pre-commit hook via interactive prompts when secrets is already installed',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token')
        .withSecretsBinaryInstalled();

      // Real git repo so that git commands (e.g. git config core.hooksPath) behave correctly
      // and resolveGitHooksDir() resolves to .git/hooks as expected
      mkdirSync(harness.cwd.path, { recursive: true });
      Bun.spawnSync(['git', 'init'], { cwd: harness.cwd.path });

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
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token')
        .withSecretsBinaryInstalled();

      mkdirSync(harness.cwd.path, { recursive: true });
      Bun.spawnSync(['git', 'init'], { cwd: harness.cwd.path });

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
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token')
        .withSecretsBinaryInstalled();

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
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token')
        .withSecretsBinaryInstalled();

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
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token')
        .withSecretsBinaryInstalled();

      mkdirSync(harness.cwd.path, { recursive: true });
      Bun.spawnSync(['git', 'init'], { cwd: harness.cwd.path });
      Bun.spawnSync(['git', 'config', 'core.hooksPath', '.husky'], { cwd: harness.cwd.path });
      mkdirSync(join(harness.cwd.path, '.husky'), { recursive: true });

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
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token')
        .withSecretsBinaryInstalled();

      mkdirSync(harness.cwd.path, { recursive: true });
      Bun.spawnSync(['git', 'init'], { cwd: harness.cwd.path });
      Bun.spawnSync(['git', 'config', 'core.hooksPath', '.husky'], { cwd: harness.cwd.path });
      mkdirSync(join(harness.cwd.path, '.husky'), { recursive: true });

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
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token')
        .withSecretsBinaryInstalled();

      mkdirSync(harness.cwd.path, { recursive: true });
      Bun.spawnSync(['git', 'init'], { cwd: harness.cwd.path });
      harness.cwd.writeFile('.pre-commit-config.yaml', 'repos: []\n');

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
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token')
        .withSecretsBinaryInstalled();

      mkdirSync(harness.cwd.path, { recursive: true });
      Bun.spawnSync(['git', 'init'], { cwd: harness.cwd.path });
      harness.cwd.writeFile('.pre-commit-config.yaml', 'repos: []\n');

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
