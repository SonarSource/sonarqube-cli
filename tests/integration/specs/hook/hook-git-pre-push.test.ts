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
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  SECRETS_INACTIVE_BINARY_MISSING,
  SECRETS_INACTIVE_UNAUTHENTICATED,
} from '@/commands/hook/hook-dependencies.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalBinaryName } from '@/core/host/install/secrets.ts';

import { TestHarness } from '../../harness';
import { addBareRemote, commitFile, git, initGitRepo, publishRef } from './git-test-helpers';

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

  describe('scan scope against a real remote', () => {
    const BARE_REMOTE = '.bare-remote.git';

    function repoWithRemote(): string {
      initGitRepo(harness.cwd.path);
      addBareRemote(harness.cwd.path, join(harness.cwd.path, BARE_REMOTE));
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      return harness.cwd.path;
    }

    it(
      'does not scan anything when the pushed ref adds no commits to the remote',
      async () => {
        const cwd = repoWithRemote();
        const sha = commitFile(cwd, 'leak.js', `const token = "${GITHUB_TEST_TOKEN}";`);
        publishRef(cwd, 'HEAD:refs/heads/master');

        // Same commit, new ref name: nothing is transferred, so the already-published
        // secret must not block the push.
        const result = await harness.runWithStdin(
          'hook git-pre-push',
          pushRefLine(sha, GIT_NULL_OID, 'refs/heads/release-1.0'),
        );

        expect(result.exitCode).toBe(0);
      },
      { timeout: 30000 },
    );

    it(
      'does not scan anything when tagging an already-pushed commit',
      async () => {
        const cwd = repoWithRemote();
        const sha = commitFile(cwd, 'leak.js', `const token = "${GITHUB_TEST_TOKEN}";`);
        publishRef(cwd, 'HEAD:refs/heads/master');

        const result = await harness.runWithStdin(
          'hook git-pre-push',
          pushRefLine(sha, GIT_NULL_OID, 'refs/tags/v1.0'),
        );

        expect(result.exitCode).toBe(0);
      },
      { timeout: 30000 },
    );

    it(
      'scans only the new commits, not the already-published base',
      async () => {
        const cwd = repoWithRemote();
        commitFile(cwd, 'leak.js', `const token = "${GITHUB_TEST_TOKEN}";`);
        publishRef(cwd, 'HEAD:refs/heads/master');
        const localSha = commitFile(cwd, 'clean.js', CLEAN_CONTENT);

        const result = await harness.runWithStdin(
          'hook git-pre-push',
          pushRefLine(localSha, GIT_NULL_OID, 'refs/heads/feature'),
        );

        expect(result.exitCode).toBe(0);
      },
      { timeout: 30000 },
    );

    it(
      'does not scan upstream files pulled in by a rebase before a force-push',
      async () => {
        const cwd = repoWithRemote();
        commitFile(cwd, 'base.js', CLEAN_CONTENT);
        publishRef(cwd, 'HEAD:refs/heads/master');

        git(['switch', '-c', 'feature'], cwd);
        const firstPush = commitFile(cwd, 'mine.js', CLEAN_CONTENT);
        publishRef(cwd, 'feature:refs/heads/feature');

        git(['switch', 'master'], cwd);
        commitFile(cwd, 'upstream-leak.js', `const token = "${GITHUB_TEST_TOKEN}";`);
        publishRef(cwd, 'master:refs/heads/master');

        git(['switch', 'feature'], cwd);
        git(['rebase', 'master'], cwd);
        const rebased = git(['rev-parse', 'HEAD'], cwd);

        const result = await harness.runWithStdin(
          'hook git-pre-push',
          pushRefLine(rebased, firstPush, 'refs/heads/feature'),
        );

        expect(result.exitCode).toBe(0);
      },
      { timeout: 30000 },
    );

    it(
      'still scans when the remote tip is absent from the local object database',
      async () => {
        const cwd = repoWithRemote();
        commitFile(cwd, 'base.js', CLEAN_CONTENT);
        publishRef(cwd, 'HEAD:refs/heads/master');
        const localSha = commitFile(cwd, 'leak.js', `const token = "${GITHUB_TEST_TOKEN}";`);

        // Well-formed SHA that this clone has never seen — as after a colleague's push.
        const result = await harness.runWithStdin(
          'hook git-pre-push',
          pushRefLine(localSha, 'a'.repeat(40), 'refs/heads/master'),
        );

        expect(result.exitCode).toBe(1);
      },
      { timeout: 30000 },
    );

    it(
      'scans content a merge introduced itself during conflict resolution',
      async () => {
        const cwd = repoWithRemote();
        commitFile(cwd, 'base.js', CLEAN_CONTENT);
        publishRef(cwd, 'HEAD:refs/heads/master');

        git(['switch', '-c', 'side'], cwd);
        commitFile(cwd, 'side.js', CLEAN_CONTENT);
        publishRef(cwd, 'side:refs/heads/side');

        git(['switch', 'master'], cwd);
        const remoteTip = commitFile(cwd, 'main.js', CLEAN_CONTENT);
        publishRef(cwd, 'master:refs/heads/master');

        // Evil merge: the secret lives in the merge commit alone, in neither parent.
        git(['merge', '--no-commit', '--no-ff', 'side'], cwd);
        const merged = commitFile(cwd, 'evil.js', `const token = "${GITHUB_TEST_TOKEN}";`);

        const result = await harness.runWithStdin(
          'hook git-pre-push',
          pushRefLine(merged, remoteTip, 'refs/heads/master'),
        );

        expect(result.exitCode).toBe(1);
      },
      { timeout: 30000 },
    );

    it(
      'ignores a push target that is a URL rather than a configured remote',
      async () => {
        const cwd = repoWithRemote();
        commitFile(cwd, 'leak.js', `const token = "${GITHUB_TEST_TOKEN}";`);
        publishRef(cwd, 'HEAD:refs/heads/master');
        const localSha = commitFile(cwd, 'clean.js', CLEAN_CONTENT);

        // `--remotes=<url>` matches no refs, which would leave the published secret in scope.
        const result = await harness.runWithStdin(
          'hook git-pre-push',
          pushRefLine(localSha, GIT_NULL_OID, 'refs/heads/feature'),
          { extraEnv: { SONAR_PRE_PUSH_REMOTE_NAME: join(cwd, BARE_REMOTE) } },
        );

        expect(result.exitCode).toBe(0);
      },
      { timeout: 30000 },
    );

    it(
      'scopes to the remote named in the environment, not every remote',
      async () => {
        const cwd = repoWithRemote();
        addBareRemote(cwd, join(cwd, '.other-remote.git'), 'other');
        commitFile(cwd, 'leak.js', `const token = "${GITHUB_TEST_TOKEN}";`);
        publishRef(cwd, 'HEAD:refs/heads/master', 'other');
        const localSha = commitFile(cwd, 'clean.js', CLEAN_CONTENT);

        // `origin` has never held the leak; only an unscoped exclusion would drop it via `other`.
        const result = await harness.runWithStdin(
          'hook git-pre-push',
          pushRefLine(localSha, GIT_NULL_OID, 'refs/heads/feature'),
          { extraEnv: { SONAR_PRE_PUSH_REMOTE_NAME: 'origin' } },
        );

        expect(result.exitCode).toBe(1);
      },
      { timeout: 30000 },
    );
  });

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
