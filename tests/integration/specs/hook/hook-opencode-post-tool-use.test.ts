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

// Integration tests for `sonar hook opencode-post-tool-use`.

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { VORTEX_PRODUCT_URL } from '@/core/config-constants.ts';

import { readAnalysisEvents, readCommandEvents } from '../../../_common/telemetry-helpers';
import { TestHarness } from '../../harness';
import { parseSqaaRequestBody, sqaaRequestFileCount } from '../analyze/sqaa-request-helpers';
import { commitFile, initGitRepo } from './git-test-helpers';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const TEST_ORG_UUID = 'my-org-uuid';
const TEST_PROJECT = 'my-project';
const EDITED_FILE = 'src/main.ts';

function oneHourAgoIso(): string {
  return new Date(Date.now() - 60 * 60 * 1000).toISOString();
}

function toolPayload(filePath: string, tool = 'edit'): string {
  return JSON.stringify({ tool, filePath, sessionID: 'ses_test' });
}

describe('sonar hook opencode-post-tool-use', () => {
  let harness: TestHarness;
  let editedFilePath: string;

  beforeEach(async () => {
    harness = await TestHarness.create();
    initGitRepo(harness.cwd.path);
    commitFile(harness.cwd.path, 'README.md', 'baseline');
    commitFile(harness.cwd.path, 'sonar-project.properties', `sonar.projectKey=${TEST_PROJECT}\n`);
    harness.cwd.writeFile(EDITED_FILE, 'const x = 1;');
    editedFilePath = join(harness.cwd.path, EDITED_FILE);
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function sqaaCalls(server: {
    getRecordedRequests: () => Array<{ path: string; body?: string }>;
  }) {
    return server
      .getRecordedRequests()
      .filter((r) => r.path === '/a3s-analysis/analyses' || r.path === '/api/v2/a3s/analyses');
  }

  it(
    'exits 0 and outputs the analysis context for an edited file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.runWithStdin(
        'hook opencode-post-tool-use',
        toolPayload(editedFilePath),
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.context).toContain('No issues found');
      expect(output.context).toContain(EDITED_FILE);
      const calls = sqaaCalls(server);
      expect(calls).toHaveLength(1);
      expect(sqaaRequestFileCount(calls[0].body)).toBe(1);
      expect(parseSqaaRequestBody(calls[0].body).analysisDepth).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'analyzes files written with the write tool',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.runWithStdin(
        'hook opencode-post-tool-use',
        toolPayload(editedFilePath, 'write'),
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim()).context).toContain('No issues found');
      expect(sqaaCalls(server)).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'auto-detects the project key from sonar-project.properties',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.runWithStdin(
        'hook opencode-post-tool-use',
        toolPayload(editedFilePath),
      );

      expect(result.exitCode).toBe(0);
      const calls = sqaaCalls(server);
      expect(calls).toHaveLength(1);
      expect(parseSqaaRequestBody(calls[0].body).projectKey).toBe(TEST_PROJECT);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 with an empty result and skips analysis for tools other than edit and write',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.runWithStdin(
        'hook opencode-post-tool-use',
        toolPayload(editedFilePath, 'read'),
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({});
      expect(sqaaCalls(server)).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 with an empty result when the edited file does not exist',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.runWithStdin(
        'hook opencode-post-tool-use',
        toolPayload(join(harness.cwd.path, 'missing.ts')),
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({});
      expect(sqaaCalls(server)).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 with an empty result when stdin is malformed JSON',
    async () => {
      const result = await harness.runWithStdin('hook opencode-post-tool-use', 'not valid json');

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({});
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 with an empty result when not authenticated',
    async () => {
      const result = await harness.runWithStdin(
        'hook opencode-post-tool-use',
        toolPayload(editedFilePath),
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({});
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and warns about entitlement loss when SQAA 403 re-checks to not_entitled',
    async () => {
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken(VALID_TOKEN)
        .withSqaaStatusCode(403)
        .withVortexEntitlement(TEST_ORG, TEST_ORG_UUID, { allowed: false, hasEntitlement: false })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.runWithStdin(
        'hook opencode-post-tool-use',
        toolPayload(editedFilePath),
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.context).toContain('no longer available on this connection');
      expect(output.context).toContain('remove the analysis hooks');
      expect(output.context).toContain(VORTEX_PRODUCT_URL);
      expect(
        harness.stateJsonFile.asJson().config.vortexEntitlementLossNotice.lastWarnedAt,
      ).toEqual(expect.any(String));
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and stays silent on a not_entitled 403 when warned within the last 24h',
    async () => {
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken(VALID_TOKEN)
        .withSqaaStatusCode(403)
        .withVortexEntitlement(TEST_ORG, TEST_ORG_UUID, { allowed: false, hasEntitlement: false })
        .start();
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withVortexEntitlementLossWarnedAt(oneHourAgoIso());

      const result = await harness.runWithStdin(
        'hook opencode-post-tool-use',
        toolPayload(editedFilePath),
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({});
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and shows the usage-limit message every run on an over_consumption 403',
    async () => {
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken(VALID_TOKEN)
        .withSqaaStatusCode(403)
        .withVortexEntitlement(TEST_ORG, TEST_ORG_UUID, { allowed: false, hasEntitlement: true })
        .start();
      harness.state().withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
      const runHook = () =>
        harness.runWithStdin('hook opencode-post-tool-use', toolPayload(editedFilePath));

      const firstResult = await runHook();
      const secondResult = await runHook();

      expect(firstResult.exitCode).toBe(0);
      expect(JSON.parse(firstResult.stdout.trim()).context).toContain('usage limit');
      expect(secondResult.exitCode).toBe(0);
      expect(JSON.parse(secondResult.stdout.trim()).context).toContain('usage limit');
      expect(harness.stateJsonFile.asJson().config.vortexEntitlementLossNotice).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'resolves and records a non-null project_uuid on CliCommandExecuted',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .withProject(TEST_PROJECT)
        .start();
      harness.state().withTelemetryEnabled();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.runWithStdin(
        'hook opencode-post-tool-use',
        toolPayload(editedFilePath),
      );

      expect(result.exitCode).toBe(0);
      const [analysisEvent] = readAnalysisEvents(harness.sonarUserHome.path);
      expect(analysisEvent.event_payload.analyzer).toBe('sqaa');
      const [commandEvent] = readCommandEvents(harness.sonarUserHome.path);
      expect(commandEvent.event_payload.command).toBe('hook');
      expect(commandEvent.event_payload.invocation_id).toBe(
        analysisEvent.event_payload.invocation_id,
      );
      expect(commandEvent.event_payload.project_uuid).toBe(`AY${TEST_PROJECT}legacy`);
    },
    { timeout: 15000 },
  );
});
