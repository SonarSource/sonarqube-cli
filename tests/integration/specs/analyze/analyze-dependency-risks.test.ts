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

// Integration tests for `analyze dependency-risks`: pre-flight gates
// (authentication, SCA availability, project existence) plus the happy path,
// which currently runs against the no-op scanner runner and emits an empty
// `AnalyzeProjectResponse`. Once the real scanner is wired, the happy-path
// assertions will be expanded.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildLocalBinaryName } from '../../../../src/cli/commands/_common/install/sca-scanner.js';
import { detectPlatform } from '../../../../src/lib/platform-detector.js';
import { TestHarness } from '../../harness';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const SCA_SCANNER_FAILURE_PREFIX = 'Dependency risk analysis error: sca-scanner exited with code';

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
    const output = result.stdout + result.stderr;
    expect(output).toContain('❌ Not authenticated.');
    expect(output).toContain("💡 Run 'sonar auth login' to authenticate.");
  });

  it('exits with code 1 when project does not exist (settings 404)', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withScaEnabled(true)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('Project demo not found');
    expect(server.getRecordedRequests().some((r) => r.path === '/api/settings/values')).toBe(true);
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

  // todo: https://sonarsource.atlassian.net/browse/CLI-452 Add end-to-end tests
  // The next two tests assert on scanner *failure* because the in-process
  // fake server does not implement the SCA-scanner backend APIs. Move happy-path
  // coverage to a real-backend e2e suite (e.g. SonarQube Cloud staging) once one
  // exists.
  it('reports a scanner failure when the SCA backend is unavailable', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withScaEnabled(true)
      .withProject('demo')
      .withProjectSettings('demo', [])
      .start();
    harness.state().withScaScannerBinaryInstalled();
    harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

    const result = await harness.run('analyze dependency-risks --project demo --format json', {
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(SCA_SCANNER_FAILURE_PREFIX);
  });

  it(
    'auto-installs sca-scanner-cli when binary is absent',
    async () => {
      await harness.newFakeBinariesServer().start();
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(true)
        .withProject('demo')
        .withProjectSettings('demo', [])
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze dependency-risks --project demo --format json');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(SCA_SCANNER_FAILURE_PREFIX);
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        true,
      );
      const state = harness.stateJsonFile.asJson() as {
        tools: { installed: Array<{ name: string; version: string }> };
      };
      const recorded = state.tools.installed.find((t) => t.name === 'sca-scanner-cli');
      expect(recorded).toBeDefined();
      expect(recorded?.version).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'aborts when sca-scanner-cli download fails',
    async () => {
      await harness.newFakeBinariesServer().noArtifacts().start();
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(true)
        .withProject('demo')
        .withProjectSettings('demo', [])
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze dependency-risks --project demo --format json');

      expect(result.exitCode).not.toBe(0);
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        false,
      );
    },
    { timeout: 30000 },
  );

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
