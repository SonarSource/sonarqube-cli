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

// Integration tests for `analyze dependency-risks` skeleton (CLI-354).
// At this stage the command is a stub: no SCA call, no settings fetch.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

const FAKE_SERVER = 'http://localhost:19999';

describe('analyze dependency-risks', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('exits with code 1 when not authenticated', async () => {
    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('❌ Not authenticated. Run: sonar auth login');
  });

  it('prints stub table output by default when authenticated', async () => {
    harness.withAuth(FAKE_SERVER, 'fake-token');

    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Project: demo');
    expect(result.stdout).toContain('(no risks)');
  });

  it('prints stub JSON output when --format json is passed', async () => {
    harness.withAuth(FAKE_SERVER, 'fake-token');

    const result = await harness.run('analyze dependency-risks --project demo --format json');

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({ project: 'demo', risks: [] });
  });
});
