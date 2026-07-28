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

// Integration tests for the background "new version available" stderr notice
// (core/update/notification.ts). The harness always spawns the CLI with
// piped stdio (never a real TTY) and defaults CI=true for determinism, so
// these tests explicitly clear CI and set SONARQUBE_CLI_MOCK_TTY to reach the
// code path that would otherwise only run for an interactive human user.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { version as CURRENT_VERSION } from '../../../../package.json';
import { TestHarness } from '../../harness';

const INTERACTIVE_ENV = { CI: '', SONARQUBE_CLI_MOCK_TTY: '1' };
const NOTICE_TEXT = 'A new version of SonarQube CLI is available';

describe('update notification', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'prints the notice on stderr (never stdout) for an eligible command when a newer version exists',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      await harness.newFakeBinariesServer().withStableVersion('99.0.0').start();

      const result = await harness.run('auth status', { extraEnv: INTERACTIVE_ENV });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(NOTICE_TEXT);
      expect(result.stderr).toContain('Run `sonar update` to update to v99.0.0');
      expect(result.stdout).not.toContain(NOTICE_TEXT);
    },
    { timeout: 15000 },
  );

  it(
    'does not print the notice when already on the latest version',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      await harness.newFakeBinariesServer().withStableVersion(CURRENT_VERSION).start();

      const result = await harness.run('auth status', { extraEnv: INTERACTIVE_ENV });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain(NOTICE_TEXT);
    },
    { timeout: 15000 },
  );

  it(
    'does not print the notice for a command that never opted in',
    async () => {
      await harness.newFakeBinariesServer().withStableVersion('99.0.0').start();

      const result = await harness.run('config telemetry --disabled', {
        extraEnv: INTERACTIVE_ENV,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain(NOTICE_TEXT);
    },
    { timeout: 15000 },
  );

  it(
    'suppresses the notice for list issues in its default (JSON) format',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      await harness.newFakeBinariesServer().withStableVersion('99.0.0').start();

      const result = await harness.run('list issues --project my-project', {
        extraEnv: INTERACTIVE_ENV,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain(NOTICE_TEXT);
    },
    { timeout: 15000 },
  );

  it(
    'shows the notice for list issues when --format table is requested',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      await harness.newFakeBinariesServer().withStableVersion('99.0.0').start();

      const result = await harness.run('list issues --project my-project --format table', {
        extraEnv: INTERACTIVE_ENV,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(NOTICE_TEXT);
    },
    { timeout: 15000 },
  );
});
