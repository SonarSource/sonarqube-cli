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
import { findInstalledFeature } from './state-helpers';

describe('integrate factory', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('records Factory without prompts or generated files', async () => {
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.withAuth(server.baseUrl(), 'test-token');

    const result = await harness.run('integrate factory --non-interactive');

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('Select the tool');
    expect(findInstalledFeature(harness, 'factory', 'factory-integration', 'global')).toBeDefined();
    expect(harness.userHome.exists('.factory')).toBe(false);
    expect(harness.cwd.exists('.factory')).toBe(false);
  });

  it('accepts only --non-interactive as an option', async () => {
    const result = await harness.run('integrate factory --help');

    expect(result.stdout).toContain('--non-interactive');
    expect(result.stdout).not.toContain('--project');
    expect(result.stdout).not.toContain('--global');
  });
});
