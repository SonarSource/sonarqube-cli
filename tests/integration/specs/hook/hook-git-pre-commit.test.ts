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

// Integration tests for `sonar hook git-pre-commit`:
// graceful skips and end-to-end scan of staged files in a real local git repo.

import { chmodSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildLocalBinaryName } from '../../../../src/cli/commands/_common/install/secrets';
import { detectPlatform } from '../../../../src/lib/platform-detector';
import { TestHarness } from '../../harness';
import { initGitRepo, stageFile } from './git-test-helpers';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';

// Unreachable but well-formed server URL: binary handles connection-refused gracefully.
const FAKE_SERVER = 'http://localhost:19999';
const VALID_TOKEN = 'integration-test-token';

describe('sonar hook git-pre-commit', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 when no files are staged',
    async () => {
      initGitRepo(harness.cwd.path);
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 outside of a git repo (graceful skip)',
    async () => {
      // cwd is not a git repo — git diff --cached will fail, getStagedFiles returns []
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 when not authenticated (graceful skip, even with a secret staged)',
    async () => {
      initGitRepo(harness.cwd.path);
      harness.state().withSecretsBinaryInstalled();
      // Stage a file with a secret — if the auth guard were missing the scan would run and exit 1
      stageFile(harness.cwd.path, 'secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      // No auth configured

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 when binary is not installed (graceful skip, even with a secret staged)',
    async () => {
      initGitRepo(harness.cwd.path);
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      // Stage a file with a secret — if the binary guard were missing the scan attempt would fail
      stageFile(harness.cwd.path, 'secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      // No binary installed

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 for a staged clean file',
    async () => {
      initGitRepo(harness.cwd.path);
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      stageFile(harness.cwd.path, 'clean.js', CLEAN_CONTENT);

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(0);
    },
    { timeout: 30000 },
  );

  it(
    'exits 1 when staged file contains a secret',
    async () => {
      initGitRepo(harness.cwd.path);
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      stageFile(harness.cwd.path, 'secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(1);
    },
    { timeout: 30000 },
  );

  it(
    'exits 1 when binary spawn fails (graceful error)',
    async () => {
      initGitRepo(harness.cwd.path);
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      stageFile(harness.cwd.path, 'clean.js', CLEAN_CONTENT);

      // Place a non-executable file at the binary path so spawnProcess throws
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      chmodSync(harness.cliHome.file('bin', binaryName).path, 0o644);

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(1);
    },
    { timeout: 30000 },
  );
});
