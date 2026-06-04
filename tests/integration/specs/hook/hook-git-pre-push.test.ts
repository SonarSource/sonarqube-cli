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
import { commitFile, initGitRepo, stageFile } from './git-test-helpers';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';
const GIT_NULL_OID = '0000000000000000000000000000000000000000';

// Unreachable but well-formed server URL: binary handles connection-refused gracefully.
const FAKE_SERVER = 'http://localhost:19999';
const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const PACKAGE_JSON_CONTENT = '{"name":"demo","version":"1.0.0"}';
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
    'exits 1 when binary spawn fails with env-based auth (CI mode, fail hard)',
    async () => {
      initGitRepo(harness.cwd.path);
      const sha = commitFile(harness.cwd.path, 'clean.js', CLEAN_CONTENT);

      // Place a non-executable file at the binary path so spawnProcess throws
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      chmodSync(harness.cliHome.file('bin', binaryName).path, NON_EXECUTABLE_MODE);

      const result = await harness.run('hook git-pre-push', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
        extraEnv: { SONARQUBE_CLI_TOKEN: VALID_TOKEN, SONARQUBE_CLI_SERVER: FAKE_SERVER },
      });

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

      const result = await harness.run('hook git-pre-push', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
      });

      expect(result.exitCode).toBe(0);
    },
    { timeout: 30000 },
  );

  it(
    'exits 2 when --dependency-risks is set without -p',
    async () => {
      const sha = 'abc1234abc1234abc1234abc1234abc1234abc123';
      const result = await harness.run('hook git-pre-push --dependency-risks', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('-p');
    },
    { timeout: 15000 },
  );

  it(
    'warns about uncommitted changes during a push',
    async () => {
      initGitRepo(harness.cwd.path);
      const sha = commitFile(harness.cwd.path, 'clean.js', CLEAN_CONTENT);
      stageFile(harness.cwd.path, 'extra.ts', CLEAN_CONTENT);

      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.run('hook git-pre-push', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Uncommitted changes detected');
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 when -p is set without --dependency-risks (secrets-only, no dep-risks side effects)',
    async () => {
      initGitRepo(harness.cwd.path);
      const sha = commitFile(harness.cwd.path, 'package.json', PACKAGE_JSON_CONTENT);

      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.run('hook git-pre-push -p demo', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).not.toContain('dependency manifests');
    },
    { timeout: 30000 },
  );

  describe('with --dependency-risks', () => {
    it(
      'exits 0 when stdin is empty (no refs)',
      async () => {
        const result = await harness.run('hook git-pre-push -p demo --dependency-risks', {
          stdin: '',
        });
        expect(result.exitCode).toBe(0);
      },
      { timeout: 15000 },
    );

    it(
      'exits 0 when not authenticated (graceful skip)',
      async () => {
        harness.state().withScaScannerBinaryInstalled();
        const sha = 'abc1234abc1234abc1234abc1234abc1234abc123';
        const result = await harness.run('hook git-pre-push -p demo --dependency-risks', {
          stdin: pushRefLine(sha, GIT_NULL_OID),
        });
        expect(result.exitCode).toBe(0);
      },
      { timeout: 15000 },
    );

    it(
      'exits 0 when sca-scanner binary is not installed (graceful skip)',
      async () => {
        harness.withAuth(FAKE_SERVER, VALID_TOKEN, TEST_ORG);
        const sha = 'abc1234abc1234abc1234abc1234abc1234abc123';
        const result = await harness.run('hook git-pre-push -p demo --dependency-risks', {
          stdin: pushRefLine(sha, GIT_NULL_OID),
        });
        expect(result.exitCode).toBe(0);
      },
      { timeout: 15000 },
    );

    it(
      'exits 0 when pushed files contain no dependency manifests',
      async () => {
        initGitRepo(harness.cwd.path);
        const sha = commitFile(harness.cwd.path, 'index.ts', CLEAN_CONTENT);

        harness.state().withScaScannerBinaryInstalled();
        harness.withAuth(FAKE_SERVER, VALID_TOKEN, TEST_ORG);

        const result = await harness.run('hook git-pre-push -p demo --dependency-risks', {
          stdin: pushRefLine(sha, GIT_NULL_OID),
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain(
          'No dependency manifests changed in this push',
        );
      },
      { timeout: 30000 },
    );

    it(
      'exits 0 (fail-open) when a manifest changed but the SCA backend is unavailable',
      async () => {
        initGitRepo(harness.cwd.path);
        const sha = commitFile(harness.cwd.path, 'package.json', PACKAGE_JSON_CONTENT);

        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withScaEnabled(true)
          .withProject('demo')
          .withProjectSettings('demo', [])
          .start();
        harness.state().withScaScannerBinaryInstalled();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

        const result = await harness.run('hook git-pre-push -p demo --dependency-risks', {
          stdin: pushRefLine(sha, GIT_NULL_OID),
          timeoutMs: 45_000,
        });

        // Hook is fail-open on scanner failure: warn on stderr, push not blocked.
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('push not blocked');
      },
      { timeout: 60000 },
    );
  });
});
