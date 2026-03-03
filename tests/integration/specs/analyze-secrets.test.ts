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

// Integration tests for `analyze secrets` — covers both unauthenticated and authenticated scans.
//
// Note: hardcoded token below is an intentional test fixture for the secret scanner.
// sonar-ignore-next-line S6769

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestHarness } from '../harness/index.js';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';
const VALID_TOKEN = 'integration-test-token';

describe('analyze secrets', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 0 for clean file when binary is installed (--file)',
    async () => {
      harness.env().withSecretsBinaryInstalled();

      const testDir = await harness.newFileSystem().withFile('clean.js', CLEAN_CONTENT).build();

      const result = await harness.run(`analyze secrets --file ${testDir}/clean.js`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Scan completed successfully');
    },
    { timeout: 30000 },
  );

  it(
    'exits with code 51 for file with secrets when binary is installed (--file)',
    async () => {
      harness.env().withSecretsBinaryInstalled();

      const testDir = await harness
        .newFileSystem()
        .withFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`)
        .build();

      const result = await harness.run(`analyze secrets --file ${testDir}/secrets.js`);

      expect(result.exitCode).toBe(51);
      // Binary always reports auth status when no credentials are configured
      expect(result.stdout + result.stderr).toContain('Authentication was not successful');
      expect(result.stdout + result.stderr).toContain('GitHub Token');
    },
    { timeout: 30000 },
  );

  it(
    'exits with code 0 for clean content via --stdin when binary is installed',
    async () => {
      harness.env().withSecretsBinaryInstalled();

      const result = await harness.run('analyze secrets --stdin', { stdin: CLEAN_CONTENT });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Scan completed successfully');
    },
    { timeout: 30000 },
  );

  it(
    'exits with code 51 for content with secrets via --stdin when binary is installed',
    async () => {
      harness.env().withSecretsBinaryInstalled();

      const result = await harness.run('analyze secrets --stdin', {
        stdin: `const token = "${GITHUB_TEST_TOKEN}";`,
      });

      expect(result.exitCode).toBe(51);
      // Binary always reports auth status when no credentials are configured
      expect(result.stdout + result.stderr).toContain('Authentication was not successful');
      expect(result.stdout + result.stderr).toContain('GitHub Token');
    },
    { timeout: 30000 },
  );

  it(
    'exits with code 1 and reports binary not installed when binary is absent',
    async () => {
      // No withSecretsBinaryInstalled() — binary absent
      const testDir = await harness.newFileSystem().withFile('file.js', CLEAN_CONTENT).build();

      const result = await harness.run(`analyze secrets --file ${testDir}/file.js`);

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('not installed');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when neither --file nor --stdin is provided',
    async () => {
      harness.env().withSecretsBinaryInstalled();

      const result = await harness.run('analyze secrets');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('--file or --stdin');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 for non-existent file path',
    async () => {
      harness.env().withSecretsBinaryInstalled();

      const result = await harness.run('analyze secrets --file /nonexistent/path/file.txt');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('File not found');
    },
    { timeout: 15000 },
  );

  it(
    'forwards auth to binary when SONAR_CLI_TOKEN + SONAR_CLI_SERVER are set',
    async () => {
      harness.env().withSecretsBinaryInstalled();
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();

      // Use a file with secrets so the binary outputs exit 51 and CLI forwards binary stderr.
      // With valid auth the binary must NOT report "Authentication was not successful".
      const testDir = await harness
        .newFileSystem()
        .withFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`)
        .build();

      const result = await harness.run(`analyze secrets --file ${testDir}/secrets.js`, {
        extraEnv: {
          SONAR_CLI_TOKEN: VALID_TOKEN,
          SONAR_CLI_SERVER: server.baseUrl(),
          SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true',
        },
      });

      expect(result.exitCode).toBe(51);
      expect(result.stdout + result.stderr).not.toContain('Authentication was not successful');
      expect(result.stdout + result.stderr).toContain('GitHub Token');
    },
    { timeout: 30000 },
  );

  it(
    'forwards auth from active connection and keychain to binary',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();

      harness
        .env()
        .withSecretsBinaryInstalled()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), VALID_TOKEN);

      // Use a file with secrets so the binary outputs exit 51 and CLI forwards binary stderr.
      // With valid auth the binary must NOT report "Authentication was not successful".
      const testDir = await harness
        .newFileSystem()
        .withFile('secrets.js', `const token = "${GITHUB_TEST_TOKEN}";`)
        .build();

      const result = await harness.run(`analyze secrets --file ${testDir}/secrets.js`, {
        extraEnv: {
          SONAR_SECRETS_ALLOW_UNSECURE_HTTP: 'true',
        },
      });

      expect(result.exitCode).toBe(51);
      expect(result.stdout + result.stderr).not.toContain('Authentication was not successful');
      expect(result.stdout + result.stderr).toContain('GitHub Token');
    },
    { timeout: 30000 },
  );
});
