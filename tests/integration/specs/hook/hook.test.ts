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

// Integration tests for `sonar hook` command infrastructure

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('sonar hook', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'is hidden — does not appear in root help',
    async () => {
      const result = await harness.run('');
      expect(result.exitCode).toBe(0);
      // 'hook' must not appear as a listed command entry — the regex matches the 4-space indented
      // format used in the COMMANDS section, so it only flags actual command entries, not other
      // lines that happen to contain the word 'hook' (e.g. descriptions or option names)
      expect(result.stdout).not.toMatch(/^\s{4}hook\b/m);
    },
    { timeout: 15000 },
  );

  it(
    'sonar hook exits 0 and shows command description',
    async () => {
      const result = await harness.run('hook');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Internal hook handlers for agent and git hooks');
    },
    { timeout: 15000 },
  );
});
