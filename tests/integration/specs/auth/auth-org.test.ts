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

// Integration tests for `sonar auth org`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('auth org', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 and prompts to authenticate when not logged in',
    async () => {
      const result = await harness.run('auth org org-b');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('❌ Not authenticated.');
      expect(output).toContain("  → Run 'sonar auth login' to authenticate.");
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and points to the environment when environment variable authentication is active',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('env-token').start();

      const result = await harness.run('auth org org-b', {
        extraEnv: {
          SONARQUBE_CLI_TOKEN: 'env-token',
          SONARQUBE_CLI_SERVER: server.baseUrl(),
          SONARQUBE_CLI_ORG: 'org-a',
        },
      });

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('❌ Environment variable authentication is already active.');
      expect(output).toContain('  → Set SONARQUBE_CLI_ORG to the organization you want to use.');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when connected to SonarQube Server (not Cloud)',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('valid-token').start();

      harness.withAuth(server.baseUrl(), 'valid-token');

      const result = await harness.run('auth org org-b');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Organizations are only applicable to SonarQube Cloud connection.');
    },
    { timeout: 15000 },
  );
});
