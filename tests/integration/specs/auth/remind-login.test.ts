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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('auth remind-login', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'skips the notification when the user is already signed in',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('remind-token').start();
      harness.state().withAuth(server.baseUrl(), 'remind-token');

      const result = await harness.run('auth remind-login');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Already authenticated -- skipping notification.');
    },
    { timeout: 15000 },
  );

  it.skipIf(process.platform === 'darwin')(
    'rejects --alerter outside macOS',
    async () => {
      const result = await harness.run('auth remind-login --alerter');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--alerter is supported on macOS only.');
    },
    { timeout: 15000 },
  );
});
