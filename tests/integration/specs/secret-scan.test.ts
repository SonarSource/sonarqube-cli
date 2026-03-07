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

/**
 * Integration tests for `analyze secrets --file` via the compiled binary.
 *
 * Runs the real sonarqube-cli binary against the real sonar-secrets binary.
 * No auth credentials needed — sonar-secrets works with built-in patterns.
 *
 * Note: hardcoded tokens below are intentional test fixtures for the secret scanner.
 * sonar-ignore-next-line S6769
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TestHarness } from '../harness';

// Hardcoded test tokens — intentional fixtures for secret detection, not real credentials
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';

const SYSTEM_STATE_FILE = join(homedir(), '.sonar', 'sonarqube-cli', 'state.json');

describe('analyze secrets --file', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'detects secret in file (exit code 51)',
    async () => {
      harness.cwd.writeFile('src/config.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.run(`analyze secrets --file src/config.js`);

      expect(result.exitCode).toBe(51);
      // Binary always reports auth status when no credentials are configured
      expect(result.stdout + result.stderr).toContain('Authentication was not successful');
    },
    { timeout: 30000 },
  );

  it(
    'returns exit code 0 for a clean file',
    async () => {
      harness.cwd.writeFile('src/clean.js', CLEAN_CONTENT);
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.run(`analyze secrets --file src/clean.js`);

      expect(result.exitCode).toBe(0);
    },
    { timeout: 30000 },
  );

  it(
    'exits with code 1 for non-existent file',
    async () => {
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.run('analyze secrets --file /nonexistent/path/file.txt');

      expect(result.exitCode).toBe(1);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when neither --file nor --stdin is provided',
    async () => {
      const result = await harness.run('analyze secrets');

      expect(result.exitCode).toBe(1);
    },
    { timeout: 15000 },
  );

  it(
    'does not modify the system CLI dir during execution',
    async () => {
      const mtimeBefore = existsSync(SYSTEM_STATE_FILE)
        ? statSync(SYSTEM_STATE_FILE).mtimeMs
        : null;

      // auth login --with-token writes state.json — a reliable way to trigger a write
      await harness.run('auth login --with-token test-token --server http://127.0.0.1:19999');

      const mtimeAfter = existsSync(SYSTEM_STATE_FILE) ? statSync(SYSTEM_STATE_FILE).mtimeMs : null;

      // System state must be untouched
      expect(mtimeAfter).toBe(mtimeBefore);
      // Isolated dir must have received the write
      expect(existsSync(join(harness.isolatedDir, 'state.json'))).toBe(true);
    },
    { timeout: 15000 },
  );
});
