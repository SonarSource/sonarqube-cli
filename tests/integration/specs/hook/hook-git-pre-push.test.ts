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

import { buildLocalBinaryName } from '../../../../src/cli/commands/_common/install/secrets';
import { detectPlatform } from '../../../../src/lib/platform-detector';
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
      const result = await harness.run('hook git-pre-push', { stdin: '' });
      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 for branch deletion (localSha is all zeros)',
    async () => {
      const stdin = pushRefLine(GIT_NULL_OID, 'abc1234abc1234abc1234abc1234abc1234abc123');
      const result = await harness.run('hook git-pre-push', { stdin });
      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 when all lines are malformed (missing fields)',
    async () => {
      const stdin = 'invalid-line\nrefs/heads/main only-one-field\n';
      const result = await harness.run('hook git-pre-push', { stdin });
      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 when not authenticated (graceful skip)',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      const sha = 'abc1234abc1234abc1234abc1234abc1234abc123';
      const result = await harness.run('hook git-pre-push', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
      });
      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 when binary is not installed (graceful skip)',
    async () => {
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      const sha = 'abc1234abc1234abc1234abc1234abc1234abc123';
      const result = await harness.run('hook git-pre-push', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
      });
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

      const result = await harness.run('hook git-pre-push', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
      });

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

      const result = await harness.run('hook git-pre-push', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
      });

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

      const result = await harness.run('hook git-pre-push', {
        stdin: pushRefLine(localSha, remoteSha),
      });

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

      const result = await harness.run('hook git-pre-push', {
        stdin: pushRefLine(localSha, remoteSha),
      });

      expect(result.exitCode).toBe(1);
    },
    { timeout: 30000 },
  );

  it(
    'exits 1 when binary spawn fails (graceful error)',
    async () => {
      initGitRepo(harness.cwd.path);
      const sha = commitFile(harness.cwd.path, 'clean.js', CLEAN_CONTENT);

      // Place a non-executable file at the binary path so spawnProcess throws
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      chmodSync(harness.cliHome.file('bin', binaryName).path, 0o644);

      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.run('hook git-pre-push', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
      });

      expect(result.exitCode).toBe(1);
    },
    { timeout: 30000 },
  );
});
