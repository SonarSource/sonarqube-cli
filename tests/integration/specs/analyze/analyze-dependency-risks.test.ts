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

// Integration tests for `analyze dependency-risks` (CLI-354 skeleton + CLI-355 SCA gate
// + CLI-356 analysis properties fetch). The command is still a stub for output, but
// now pre-flights `/sca/enabled`, validates the project, and fetches analysis
// properties from `/api/settings/values`.

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
      .withProject('demo')
      .withProjectSettings('demo', [
        { key: 'sonar.exclusions', values: ['**/test/**', '**/dist/**'], inherited: false },
        { key: 'sonar.sca.foo', value: 'bar', inherited: false },
        { key: 'sonar.scm.exclusions.disabled', value: 'true', inherited: false },
      ])
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Scan Summary: \d+ dependencies checked\. \d+ risks found/);
    expect(result.stdout).toMatch(
      /SEVERITY\s+STATUS\s+TYPE\s+PACKAGE\s+MANIFEST\s+ISSUE\s+REMEDIATION/,
    );
    expect(result.stdout).toMatch(/package-lock\.json/);
    expect(result.stdout).toMatch(/Vulnerability.*CVE-\d{4}-\d+/);
    expect(result.stdout).toMatch(/License.*GPL-3\.0/);
    expect(result.stdout).toMatch(/Malware.*Malicious package.*Remove dependency/);
    expect(result.stdout).toMatch(/NEW/);
    expect(result.stdout).toMatch(/Errors:/);
    expect(result.stdout).toMatch(
      /\[MISSING_LOCKFILE\] requirements\.txt: Lockfile not found for requirements\.txt/,
    );
    expect(result.stdout).toMatch(/\[INEXACT_VERSIONS\] Some dependencies use inexact version/);

    const recorded = server.getRecordedRequests();
    const scaCalls = recorded.filter((r) => r.path === '/sca/enabled');
    expect(scaCalls).toHaveLength(1);
    expect(scaCalls[0].query.organization).toBe(TEST_ORG);

    const componentShowIndex = recorded.findIndex((r) => r.path === '/api/components/show');
    const settingsIndex = recorded.findIndex((r) => r.path === '/api/settings/values');
    expect(componentShowIndex).toBeGreaterThanOrEqual(0);
    expect(settingsIndex).toBeGreaterThan(componentShowIndex);
    expect(recorded[settingsIndex].query.component).toBe('demo');
  });

  it('prints stub JSON output when --format json is passed (on-premise)', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withScaEnabled(true)
      .withProject('demo')
      .withProjectSettings('demo', [])
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('analyze dependency-risks --project demo --format json');

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.project).toBe('demo');
    expect(Array.isArray(parsed.risks)).toBe(true);
    expect(parsed.risks.length).toBeGreaterThan(0);
    expect(parsed.risks[0]).toHaveProperty('packageName');
    expect(parsed.risks[0]).toHaveProperty('type');
    expect(parsed.risks[0]).toHaveProperty('severity');
    expect(parsed.risks[0]).toHaveProperty('quality');
    expect(parsed.risks[0]).toHaveProperty('status');
    expect(parsed.risks[0]).toHaveProperty('releaseKey');
    expect(parsed.risks[0]).toHaveProperty('issueKey');
    expect(Array.isArray(parsed.risks[0].dependencyFilePaths)).toBe(true);
    expect(Array.isArray(parsed.risks[0].dependencyChains)).toBe(true);
    const types = parsed.risks.map((r: { type: string }) => r.type);
    expect(types).toEqual([
      'MALWARE',
      'VULNERABILITY',
      'VULNERABILITY',
      'VULNERABILITY',
      'PROHIBITED_LICENSE',
      'VULNERABILITY',
    ]);
    const packageNames = parsed.risks.map((r: { packageName: string }) => r.packageName);
    expect(packageNames).toEqual([...packageNames].sort());
    const licenseRisk = parsed.risks.find((r: { type: string }) => r.type === 'PROHIBITED_LICENSE');
    expect(licenseRisk.licenseExpression).toBe('GPL-3.0');
    const malwareRisk = parsed.risks.find((r: { type: string }) => r.type === 'MALWARE');
    expect(malwareRisk.newlyIntroduced).toBe(true);
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors[0]).toEqual({
      id: 'err-1',
      code: 'MISSING_LOCKFILE',
      path: 'requirements.txt',
      message: 'Lockfile not found for requirements.txt',
    });
    expect(parsed.errors[1].code).toBe('INEXACT_VERSIONS');
    expect(parsed.errors[1].path).toBeNull();
    expect(server.getRecordedRequests().some((r) => r.path === '/api/v2/sca/enabled')).toBe(true);
    expect(
      server
        .getRecordedRequests()
        .some((r) => r.path === '/api/settings/values' && r.query.component === 'demo'),
    ).toBe(true);
  });

  it('exits with code 1 with "No project" when project does not exist', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withScaEnabled(true)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('No project: demo');
    // Settings fetch must be skipped when the project pre-check fails.
    expect(server.getRecordedRequests().some((r) => r.path === '/api/settings/values')).toBe(false);
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
