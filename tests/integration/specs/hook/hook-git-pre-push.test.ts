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

// Integration tests for `sonar hook git-pre-push`:
// ref parsing, graceful skips, and end-to-end scan with a real local git repo.

import { chmodSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  SECRETS_INACTIVE_BINARY_MISSING,
  SECRETS_INACTIVE_UNAUTHENTICATED,
} from '@/commands/hook/hook-dependencies.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalBinaryName } from '@/core/host/install/secrets.ts';

import { TestHarness } from '../../harness';
import { commitFile, initGitRepo } from './git-test-helpers';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';
const GIT_NULL_OID = '0000000000000000000000000000000000000000';

// Unreachable but well-formed server URL: binary handles connection-refused gracefully.
const FAKE_SERVER = 'http://localhost:19999';
const VALID_TOKEN = 'integration-test-token';

const NON_EXECUTABLE_MODE = 0o644;

function pushRefLine(localSha: string, remoteSha: string, branch = 'refs/heads/main'): string {
  return `${branch} ${localSha} ${branch} ${remoteSha}\n`;
}

describe('sonar hook git-pre-push', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 when stdin is empty (no refs)',
    async () => {
      const result = await harness.runWithStdin('hook git-pre-push', '');
      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 for branch deletion (localSha is all zeros)',
    async () => {
      const stdin = pushRefLine(GIT_NULL_OID, 'abc1234abc1234abc1234abc1234abc1234abc123');
      const result = await harness.runWithStdin('hook git-pre-push', stdin);
      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 when all lines are malformed (missing fields)',
    async () => {
      const stdin = 'invalid-line\nrefs/heads/main only-one-field\n';
      const result = await harness.runWithStdin('hook git-pre-push', stdin);
      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 1 with the unauthenticated message when not authenticated (fails closed)',
    async () => {
      initGitRepo(harness.cwd.path);
      const sha = commitFile(harness.cwd.path, 'clean.js', CLEAN_CONTENT);
      harness.state().withSecretsBinaryInstalled();
      // No auth configured

      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(sha, GIT_NULL_OID),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(SECRETS_INACTIVE_UNAUTHENTICATED);
    },
    { timeout: 30000 },
  );

  it(
    'exits 1 with the binary-missing message when binary is not installed (fails closed)',
    async () => {
      initGitRepo(harness.cwd.path);
      const sha = commitFile(harness.cwd.path, 'clean.js', CLEAN_CONTENT);
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      // No binary installed

      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(sha, GIT_NULL_OID),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(SECRETS_INACTIVE_BINARY_MISSING);
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 when the push has no files to scan, even when unauthenticated',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      const sha = 'abc1234abc1234abc1234abc1234abc1234abc123';
      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(sha, GIT_NULL_OID),
      );
      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 for a clean commit on a new branch (real git repo)',
    async () => {
      initGitRepo(harness.cwd.path);
      const sha = commitFile(harness.cwd.path, 'clean.js', CLEAN_CONTENT);

      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(sha, GIT_NULL_OID),
      );

      expect(result.exitCode).toBe(0);
    },
    { timeout: 30000 },
  );

  it(
    'exits 1 when committed file contains a secret (real git repo)',
    async () => {
      initGitRepo(harness.cwd.path);
      const sha = commitFile(
        harness.cwd.path,
        'secret.js',
        `const token = "${GITHUB_TEST_TOKEN}";`,
      );

      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(sha, GIT_NULL_OID),
      );

      expect(result.exitCode).toBe(1);
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 for a clean push to an existing remote branch',
    async () => {
      initGitRepo(harness.cwd.path);
      const remoteSha = commitFile(harness.cwd.path, 'base.js', CLEAN_CONTENT);
      const localSha = commitFile(harness.cwd.path, 'added.js', CLEAN_CONTENT);

      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(localSha, remoteSha),
      );

      expect(result.exitCode).toBe(0);
    },
    { timeout: 30000 },
  );

  it(
    'exits 1 when secret is pushed to an existing remote branch',
    async () => {
      initGitRepo(harness.cwd.path);
      const remoteSha = commitFile(harness.cwd.path, 'base.js', CLEAN_CONTENT);
      const localSha = commitFile(
        harness.cwd.path,
        'secret.js',
        `const token = "${GITHUB_TEST_TOKEN}";`,
      );

      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(localSha, remoteSha),
      );

      expect(result.exitCode).toBe(1);
    },
    { timeout: 30000 },
  );

  it(
    'exits 1 when binary spawn fails with env-based auth (CI mode, fail hard)',
    async () => {
      initGitRepo(harness.cwd.path);
      const sha = commitFile(harness.cwd.path, 'clean.js', CLEAN_CONTENT);

      // Place a non-executable file at the binary path so spawnProcess throws
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      chmodSync(harness.cliHome.file('bin', binaryName).path, NON_EXECUTABLE_MODE);

      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(sha, GIT_NULL_OID),
        {
          extraEnv: { SONARQUBE_CLI_TOKEN: VALID_TOKEN, SONARQUBE_CLI_SERVER: FAKE_SERVER },
        },
      );

      expect(result.exitCode).toBe(1);
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 when binary spawn fails with keychain auth (local mode, fail soft)',
    async () => {
      initGitRepo(harness.cwd.path);
      const sha = commitFile(harness.cwd.path, 'clean.js', CLEAN_CONTENT);

      // Place a non-executable file at the binary path so spawnProcess throws
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      chmodSync(harness.cliHome.file('bin', binaryName).path, NON_EXECUTABLE_MODE);

      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(sha, GIT_NULL_OID),
      );

      expect(result.exitCode).toBe(0);
    },
    { timeout: 30000 },
  );

  describe('files mode (pre-commit framework)', () => {
    it(
      'exits 0 when no files are passed',
      async () => {
        const result = await harness.run('hook git-pre-push');
        expect(result.exitCode).toBe(0);
      },
      { timeout: 15000 },
    );

    it(
      'exits 1 with the unauthenticated message when not authenticated (fails closed)',
      async () => {
        harness.state().withSecretsBinaryInstalled();
        harness.cwd.writeFile('clean.js', CLEAN_CONTENT);
        const result = await harness.run('hook git-pre-push clean.js');
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(SECRETS_INACTIVE_UNAUTHENTICATED);
      },
      { timeout: 15000 },
    );

    it(
      'exits 1 with the binary-missing message when binary is not installed (fails closed)',
      async () => {
        harness.withAuth(FAKE_SERVER, VALID_TOKEN);
        harness.cwd.writeFile('clean.js', CLEAN_CONTENT);
        const result = await harness.run('hook git-pre-push clean.js');
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(SECRETS_INACTIVE_BINARY_MISSING);
      },
      { timeout: 15000 },
    );

    it(
      'exits 0 when file is clean',
      async () => {
        harness.state().withSecretsBinaryInstalled();
        harness.withAuth(FAKE_SERVER, VALID_TOKEN);
        harness.cwd.writeFile('clean.js', CLEAN_CONTENT);

        const result = await harness.run('hook git-pre-push clean.js');
        expect(result.exitCode).toBe(0);
      },
      { timeout: 30000 },
    );

    it(
      'exits 1 when a passed file contains a secret',
      async () => {
        harness.state().withSecretsBinaryInstalled();
        harness.withAuth(FAKE_SERVER, VALID_TOKEN);
        harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);

        const result = await harness.run('hook git-pre-push secret.js');
        expect(result.exitCode).toBe(1);
      },
      { timeout: 30000 },
    );

    it(
      'exits 1 when binary spawn fails with env-based auth (CI mode, fail hard)',
      async () => {
        const binaryName = buildLocalBinaryName(detectPlatform());
        harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
        chmodSync(harness.cliHome.file('bin', binaryName).path, NON_EXECUTABLE_MODE);

        harness.cwd.writeFile('clean.js', CLEAN_CONTENT);

        const result = await harness.run('hook git-pre-push clean.js', {
          extraEnv: { SONARQUBE_CLI_TOKEN: VALID_TOKEN, SONARQUBE_CLI_SERVER: FAKE_SERVER },
        });

        expect(result.exitCode).toBe(1);
      },
      { timeout: 30000 },
    );

    it(
      'exits 0 when binary spawn fails with keychain auth (local mode, fail soft)',
      async () => {
        const binaryName = buildLocalBinaryName(detectPlatform());
        harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
        chmodSync(harness.cliHome.file('bin', binaryName).path, NON_EXECUTABLE_MODE);

        harness.withAuth(FAKE_SERVER, VALID_TOKEN);
        harness.cwd.writeFile('clean.js', CLEAN_CONTENT);

        const result = await harness.run('hook git-pre-push clean.js');
        expect(result.exitCode).toBe(0);
      },
      { timeout: 30000 },
    );
  });
});
