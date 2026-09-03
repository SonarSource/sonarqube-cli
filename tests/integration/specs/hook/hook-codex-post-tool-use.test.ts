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

// Integration tests for `sonar hook codex-post-tool-use`.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { VORTEX_PRODUCT_URL } from '@/core/config-constants.ts';

import { readAnalysisEvents, readCommandEvents } from '../../../_common/telemetry-helpers';
import { TestHarness } from '../../harness';
import {
  allSqaaRequestsUseDeep,
  parseSqaaRequestBody,
  sqaaRequestFileCount,
} from '../analyze/sqaa-request-helpers';
import { commitFile, initGitRepo } from './git-test-helpers';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const TEST_ORG_UUID = 'my-org-uuid';
const TEST_PROJECT = 'my-project';

function oneHourAgoIso(): string {
  return new Date(Date.now() - 60 * 60 * 1000).toISOString();
}

describe('sonar hook codex-post-tool-use', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    initGitRepo(harness.cwd.path);
    commitFile(harness.cwd.path, 'README.md', 'baseline');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 and outputs Agentic Analysis JSON when the git change set is clean',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');

      const result = await harness.run(`hook codex-post-tool-use --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(output.hookSpecificOutput.additionalContext).toContain('No issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses' || r.path === '/api/v2/a3s/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(parseSqaaRequestBody(sqaaCalls[0].body).analysisDepth).toBeUndefined();
      expect(allSqaaRequestsUseDeep(sqaaCalls)).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'auto-detects the project key when --project is omitted',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
      harness.cwd.writeFile('sonar-project.properties', `sonar.projectKey=${TEST_PROJECT}\n`);
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');

      const result = await harness.run('hook codex-post-tool-use');

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses' || r.path === '/api/v2/a3s/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(parseSqaaRequestBody(sqaaCalls[0].body).projectKey).toBe(TEST_PROJECT);
    },
    { timeout: 15000 },
  );

  it(
    'sends one multi-file STANDARD request when multiple files changed',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
      harness.cwd.writeFile('a.ts', 'const a = 1;');
      harness.cwd.writeFile('b.ts', 'const b = 2;');

      const result = await harness.run(`hook codex-post-tool-use --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses' || r.path === '/api/v2/a3s/analyses');
      expect(sqaaCalls).toHaveLength(1);
      expect(sqaaRequestFileCount(sqaaCalls[0].body)).toBe(2);
      expect(allSqaaRequestsUseDeep(sqaaCalls)).toBe(false);
      expect(parseSqaaRequestBody(sqaaCalls[0].body).analysisDepth).toBeUndefined();
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
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');

      const result = await harness.run(`hook codex-post-tool-use --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.hookSpecificOutput.additionalContext).toContain(
        'no longer available on this connection',
      );
      expect(output.hookSpecificOutput.additionalContext).toContain('remove the analysis hooks');
      expect(output.hookSpecificOutput.additionalContext).toContain(VORTEX_PRODUCT_URL);
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
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');

      const result = await harness.run(`hook codex-post-tool-use --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
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
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');
      const runHook = () => harness.run(`hook codex-post-tool-use --project ${TEST_PROJECT}`);

      const firstResult = await runHook();
      const secondResult = await runHook();

      expect(firstResult.exitCode).toBe(0);
      const firstOutput = JSON.parse(firstResult.stdout.trim());
      expect(firstOutput.hookSpecificOutput.additionalContext).toContain('usage limit');
      expect(firstOutput.hookSpecificOutput.additionalContext).not.toContain('sonar integrate');

      expect(secondResult.exitCode).toBe(0);
      const secondOutput = JSON.parse(secondResult.stdout.trim());
      expect(secondOutput.hookSpecificOutput.additionalContext).toContain('usage limit');
      // Unlike the not_entitled case, over_consumption is never throttled via
      // vortexEntitlementLossNotice, so the message keeps showing on every run.
      expect(harness.stateJsonFile.asJson().config.vortexEntitlementLossNotice).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and outputs no hook response when not authenticated',
    async () => {
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');

      const result = await harness.run(`hook codex-post-tool-use --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 with empty stdout when the git change set is empty',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run(`hook codex-post-tool-use --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses' || r.path === '/api/v2/a3s/analyses');
      expect(sqaaCalls).toHaveLength(0);
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
      // Deliberately do NOT set TELEMETRY_FLUSH_MODE_ENV: it makes storeEvent() (which owns
      // CliCommandExecuted) no-op, since it also doubles as the guard that stops the detached
      // flush worker from recursively emitting its own CliCommandExecuted event.
      harness.state().withTelemetryEnabled();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');

      const result = await harness.run(`hook codex-post-tool-use --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(0);
      const [analysisEvent] = readAnalysisEvents(harness.sonarUserHome.path);
      expect(analysisEvent.event_payload.analyzer).toBe('sqaa');

      // project_uuid lives only on CliCommandExecuted; the analysis event above is joined to
      // it on the shared invocation_id.
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
