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

// Integration tests for `sonar hook devin-post-tool-use`.

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SQAA_DEVIN_POST_TOOL_USE_CALLER_COMMAND } from '@/commands/analyze/sqaa-analysis-telemetry.ts';
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

function toolPayload(filePath: string, toolName = 'edit'): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath },
    session_id: 'devin-session',
  });
}

describe('sonar hook devin-post-tool-use', () => {
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

  async function startServer() {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withSqaaResponse({ issues: [] })
      .withProject(TEST_PROJECT)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
    return server;
  }

  it.each(['edit', 'write'])(
    'returns the analysis as PostToolUse additionalContext after the %s tool',
    async (toolName) => {
      const server = await startServer();

      const result = await harness.runWithStdin(
        'hook devin-post-tool-use',
        toolPayload(editedFilePath, toolName),
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(output.hookSpecificOutput.additionalContext).toContain('No issues found');
      expect(output.hookSpecificOutput.additionalContext).toContain(EDITED_FILE);
      expect(output.decision).toBeUndefined();
      const calls = sqaaCalls(server);
      expect(calls).toHaveLength(1);
      expect(sqaaRequestFileCount(calls[0].body)).toBe(1);
      expect(parseSqaaRequestBody(calls[0].body).projectKey).toBe(TEST_PROJECT);
    },
    { timeout: 15000 },
  );

  it.each(['read', 'exec', 'apply_patch', 'Edit', 'Write'])(
    'stays silent and skips analysis for the %s tool',
    async (toolName) => {
      const server = await startServer();

      const result = await harness.runWithStdin(
        'hook devin-post-tool-use',
        toolPayload(editedFilePath, toolName),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(sqaaCalls(server)).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'stays silent when the edited file does not exist',
    async () => {
      const server = await startServer();

      const result = await harness.runWithStdin(
        'hook devin-post-tool-use',
        toolPayload(join(harness.cwd.path, 'missing.ts')),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(sqaaCalls(server)).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'stays silent when stdin is malformed JSON',
    async () => {
      const result = await harness.runWithStdin('hook devin-post-tool-use', 'not valid json');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    { timeout: 15000 },
  );

  it(
    'stays silent when not authenticated',
    async () => {
      const result = await harness.runWithStdin(
        'hook devin-post-tool-use',
        toolPayload(editedFilePath),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    { timeout: 15000 },
  );

  it(
    'stays silent when no project is configured',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
      harness.cwd.writeFile('sonar-project.properties', '');

      const result = await harness.runWithStdin(
        'hook devin-post-tool-use',
        toolPayload(editedFilePath),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(sqaaCalls(server)).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'stays silent when the analysis request fails',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaStatusCode(500)
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.runWithStdin(
        'hook devin-post-tool-use',
        toolPayload(editedFilePath),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    { timeout: 15000 },
  );

  it(
    'warns about entitlement loss as additionalContext when the SQAA call re-checks to not_entitled',
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
        'hook devin-post-tool-use',
        toolPayload(editedFilePath),
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(output.hookSpecificOutput.additionalContext).toContain('no longer available');
      expect(output.hookSpecificOutput.additionalContext).toContain(VORTEX_PRODUCT_URL);
    },
    { timeout: 15000 },
  );

  it(
    'records the analysis with the devin-post-tool-use caller command',
    async () => {
      await startServer();
      harness.state().withTelemetryEnabled();

      const result = await harness.runWithStdin(
        'hook devin-post-tool-use',
        toolPayload(editedFilePath),
      );

      expect(result.exitCode).toBe(0);
      const [analysisEvent] = readAnalysisEvents(harness.sonarUserHome.path);
      expect(analysisEvent.event_payload.analyzer).toBe('sqaa');
      expect(analysisEvent.event_payload.caller_command).toBe(
        SQAA_DEVIN_POST_TOOL_USE_CALLER_COMMAND,
      );
      const [commandEvent] = readCommandEvents(harness.sonarUserHome.path);
      expect(commandEvent.event_payload.command).toBe('hook');
      expect(commandEvent.event_payload.invocation_id).toBe(
        analysisEvent.event_payload.invocation_id,
      );
    },
    { timeout: 15000 },
  );
});
