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

// Integration tests for `sonar hook git-pre-push` byte handling: a path or a file's content that is not plain ASCII
// crosses git, the batch encoding and the analyzer, and has to come back naming the same file.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { commitFile, git, initGitRepo } from './git-test-helpers';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const GIT_NULL_OID = '0000000000000000000000000000000000000000';
const FAKE_SERVER = 'http://localhost:19999';
const VALID_TOKEN = 'integration-test-token';

/** Two, three and four UTF-8 bytes per character; the last is a surrogate pair in UTF-16. */
const TWO_BYTE_PATH = 'café.ts';
const THREE_BYTE_PATH = '日本語.ts';
const ASTRAL_PATH = '🔑key.ts';

function pushRefLine(localSha: string, remoteSha: string, branch = 'refs/heads/main'): string {
  return `${branch} ${localSha} ${branch} ${remoteSha}\n`;
}

function secretIn(name: string): string {
  return `const ${name} = "${GITHUB_TEST_TOKEN}";\n`;
}

describe('sonar hook git-pre-push byte handling', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  /** Commits one file per non-ASCII path, each carrying the fixture token. */
  function commitNonAsciiPaths(cwd: string): string {
    for (const path of [TWO_BYTE_PATH, THREE_BYTE_PATH, ASTRAL_PATH]) {
      writeFileSync(join(cwd, path), secretIn('token'), 'utf-8');
    }
    git(['add', '-A'], cwd);
    git(['commit', '-m', 'add non-ascii paths'], cwd);
    return git(['rev-parse', 'HEAD'], cwd);
  }

  it(
    'names a file whose path is not ASCII, with git escaping the path',
    async () => {
      initGitRepo(harness.cwd.path);
      // The default: git renders a non-ASCII path as octal escapes, which the hook has to decode.
      git(['config', 'core.quotePath', 'true'], harness.cwd.path);
      const sha = commitNonAsciiPaths(harness.cwd.path);
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(sha, GIT_NULL_OID),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(TWO_BYTE_PATH);
      expect(result.stdout).toContain(THREE_BYTE_PATH);
      expect(result.stdout).toContain(ASTRAL_PATH);
      expect(result.stdout).not.toContain('\\303');
      expect(result.stdout).not.toContain('�');
    },
    { timeout: 60000 },
  );

  it(
    'names a file whose path is not ASCII, with git emitting the path raw',
    async () => {
      initGitRepo(harness.cwd.path);
      // The other half of the contract: the bytes arrive unescaped and must survive as they are.
      git(['config', 'core.quotePath', 'false'], harness.cwd.path);
      const sha = commitNonAsciiPaths(harness.cwd.path);
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(sha, GIT_NULL_OID),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(TWO_BYTE_PATH);
      expect(result.stdout).toContain(THREE_BYTE_PATH);
      expect(result.stdout).toContain(ASTRAL_PATH);
      expect(result.stdout).not.toContain('�');
    },
    { timeout: 60000 },
  );

  it(
    'reports the right line when the content before the secret is not ASCII',
    async () => {
      initGitRepo(harness.cwd.path);
      // A record header counts bytes, not characters. Counting characters would leave the analyzer reading the
      // remainder of this file as the next header, so the finding would be lost rather than merely mislocated.
      const sha = commitFile(
        harness.cwd.path,
        'content.ts',
        `// αβγδε ünïcödé 日本語テキスト ✓\n${secretIn('token')}`,
      );
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(sha, GIT_NULL_OID),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('content.ts:2');
    },
    { timeout: 60000 },
  );

  it(
    'keeps scanning past a record whose bytes are not valid text',
    async () => {
      initGitRepo(harness.cwd.path);
      // Every byte value, including NUL and sequences no decoder accepts, in a record before the secret.
      writeFileSync(
        join(harness.cwd.path, 'blob.bin'),
        Buffer.from(Array.from({ length: 256 }, (_, byte) => byte)),
      );
      writeFileSync(join(harness.cwd.path, 'after.ts'), secretIn('token'), 'utf-8');
      git(['add', '-A'], harness.cwd.path);
      git(['commit', '-m', 'add binary then secret'], harness.cwd.path);
      const sha = git(['rev-parse', 'HEAD'], harness.cwd.path);
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(sha, GIT_NULL_OID),
      );

      // The secret sits after the binary record, so finding it proves the stream stayed in step.
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('after.ts');
    },
    { timeout: 60000 },
  );

  it(
    'attributes each commit separately when both touch the same non-ASCII path',
    async () => {
      initGitRepo(harness.cwd.path);
      writeFileSync(join(harness.cwd.path, THREE_BYTE_PATH), secretIn('first'), 'utf-8');
      git(['add', '-A'], harness.cwd.path);
      git(['commit', '-m', 'add secret'], harness.cwd.path);
      const first = git(['rev-parse', 'HEAD'], harness.cwd.path);
      writeFileSync(join(harness.cwd.path, THREE_BYTE_PATH), secretIn('second'), 'utf-8');
      git(['add', '-A'], harness.cwd.path);
      git(['commit', '-m', 'change secret'], harness.cwd.path);
      const second = git(['rev-parse', 'HEAD'], harness.cwd.path);
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook git-pre-push',
        pushRefLine(second, GIT_NULL_OID),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(first);
      expect(result.stdout).toContain(second);
    },
    { timeout: 60000 },
  );
});
