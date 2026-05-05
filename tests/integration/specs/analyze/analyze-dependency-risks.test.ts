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

// Integration tests for `analyze dependency-risks` (CLI-354 skeleton + CLI-355 SCA gate).
// At this stage the command is still a stub: no analysis logic, but it now
// pre-flights `/sca/feature-enabled` (cloud) or `/api/v2/sca/feature-enabled` (on-premise).

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';

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

  it('prints stub table output by default when authenticated (cloud)', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withScaEnabled(true)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Project: demo');
    expect(result.stdout).toContain('(no risks)');
    const scaCalls = server.getRecordedRequests().filter((r) => r.path === '/sca/feature-enabled');
    expect(scaCalls).toHaveLength(1);
    expect(scaCalls[0].query.organization).toBe(TEST_ORG);
  });

  it('prints stub JSON output when --format json is passed (on-premise)', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withScaEnabled(true)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('analyze dependency-risks --project demo --format json');

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({ project: 'demo', risks: [] });
    expect(server.getRecordedRequests().some((r) => r.path === '/api/v2/sca/feature-enabled')).toBe(
      true,
    );
  });

  it('exits with code 1 when SCA is disabled on the server', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withScaEnabled(false)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'Software Composition Analysis is not available for the current server connection',
    );
  });

  it('exits with code 1 when the SCA endpoint is absent (404)', async () => {
    const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'Software Composition Analysis is not available for the current server connection',
    );
  });
});
