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

// Integration tests for the `sonar update` command and the deprecated `sonar self-update` alias

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('update command', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'sonar update --status reports an available update without a deprecation warning',
    async () => {
      const newerVersion = '99.0.0';
      await harness.newFakeBinariesServer().withStableVersion(newerVersion).start();

      const result = await harness.run('update --status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(`Update available: v${newerVersion}`);
      expect(result.stderr).not.toContain('deprecated');
    },
    { timeout: 15000 },
  );

  it(
    'sonar self-update --status still works but warns that it is deprecated',
    async () => {
      const newerVersion = '99.0.0';
      await harness.newFakeBinariesServer().withStableVersion(newerVersion).start();

      const result = await harness.run('self-update --status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(`Update available: v${newerVersion}`);
      expect(result.stderr).toContain(
        "'sonar self-update' is deprecated since 1.4. Use 'sonar update' instead.",
      );
    },
    { timeout: 15000 },
  );
});
