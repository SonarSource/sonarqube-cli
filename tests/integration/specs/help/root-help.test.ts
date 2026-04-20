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

function assertRootHelpOutput(stdout: string): void {
  expect(stdout).toContain('SonarQube CLI');
  expect(stdout).toMatch(/v\d+\.\d+\.\d+/);
  expect(stdout).toContain('QUICKSTART');
  expect(stdout).toContain('sonar auth login');
  expect(stdout).toContain('sonar verify --file <file>');
  expect(stdout).toContain('COMMANDS');
  expect(stdout).toContain('verify --file <file>');
  expect(stdout).toContain('auth');
  expect(stdout).toContain('https://docs.sonarsource.com/sonarqube-cli');
  expect(stdout).not.toContain('Usage: sonar [options] [command]');
}

describe('root help', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'sonar shows the custom help screen',
    async () => {
      const result = await harness.run('');
      expect(result.exitCode).toBe(0);
      assertRootHelpOutput(result.stdout);
    },
    { timeout: 15000 },
  );

  it(
    'sonar -h shows the custom help screen',
    async () => {
      const result = await harness.run('-h');
      expect(result.exitCode).toBe(0);
      assertRootHelpOutput(result.stdout);
    },
    { timeout: 15000 },
  );

  it(
    'sonar auth -h shows subcommand help without hanging',
    async () => {
      const result = await harness.run('auth -h');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage: sonar auth');
      expect(result.stdout).toContain('login');
      expect(result.stdout).toContain('logout');
    },
    { timeout: 15000 },
  );
});
