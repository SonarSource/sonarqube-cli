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

// Integration tests for `list issues` auth scenarios
// Complements list-issues.test.ts which covers happy-path and basic error cases

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestHarness } from '../harness/index.js';

describe('list issues — auth scenarios', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 and reports missing server when no auth is configured',
    async () => {
      const result = await harness.run('list issues --project my-project');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'No active connection found. Run: sonar auth login',
      );
    },
    { timeout: 15000 },
  );

  it(
    'uses keychain token from active state connection',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('keychain-token')
        .withProject('state-project', (p) =>
          p.withIssue({
            ruleKey: 'java:S100',
            message: 'Issue from keychain auth',
            severity: 'MINOR',
          }),
        )
        .start();

      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'keychain-token');

      const result = await harness.run('list issues --project state-project');

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.issues[0].message).toBe('Issue from keychain auth');
    },
    { timeout: 15000 },
  );
});
