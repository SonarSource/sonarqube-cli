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

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  SECRETS_INACTIVE_BINARY_MISSING,
  SECRETS_INACTIVE_UNAUTHENTICATED,
} from '@/commands/hook/hook-dependencies.ts';
import { EXIT_CODE_SECRETS_FOUND, SECRETS_CALLER_COMMANDS } from '@/core/config-constants.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalBinaryName } from '@/core/host/install/secrets.ts';

import { readStatsEvents } from '../../../_common/stats-helpers.ts';
import { readAnalysisEvents } from '../../../_common/telemetry-helpers';
import { TestHarness } from '../../harness';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';

// Unreachable but well-formed server URL: binary handles connection-refused gracefully.
const FAKE_SERVER = 'http://localhost:19999';
const VALID_TOKEN = 'integration-test-token';

function toolPayload(filePath: string, toolName = 'read'): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath },
    session_id: 'devin-session',
  });
}

describe('sonar hook devin-pre-tool-use', () => {
  let harness: TestHarness;
  let secretFilePath: string;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
    harness.cwd.writeFile('clean.js', CLEAN_CONTENT);
    secretFilePath = join(harness.cwd.path, 'secret.js');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 and denies a read of a file that contains a secret',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook devin-pre-tool-use',
        toolPayload(secretFilePath),
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain(secretFilePath);
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and allows a clean file',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook devin-pre-tool-use',
        toolPayload(join(harness.cwd.path, 'clean.js')),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and allows when stdin is malformed JSON',
    async () => {
      const result = await harness.runWithStdin('hook devin-pre-tool-use', 'not valid json');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    { timeout: 15000 },
  );

  it.each(['edit', 'write', 'exec', 'Read'])(
    'exits 0 and allows a secret file for the %s tool (only lowercase read is scanned)',
    async (toolName) => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const readResult = await harness.runWithStdin(
        'hook devin-pre-tool-use',
        toolPayload(secretFilePath),
      );
      expect(JSON.parse(readResult.stdout.trim()).hookSpecificOutput.permissionDecision).toBe(
        'deny',
      );

      const result = await harness.runWithStdin(
        'hook devin-pre-tool-use',
        toolPayload(secretFilePath, toolName),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and allows when the file does not exist',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook devin-pre-tool-use',
        toolPayload(join(harness.cwd.path, 'missing.js')),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and denies with the unauthenticated message when not authenticated',
    async () => {
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.runWithStdin(
        'hook devin-pre-tool-use',
        toolPayload(secretFilePath),
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput.permissionDecisionReason).toBe(
        SECRETS_INACTIVE_UNAUTHENTICATED,
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and denies with the binary-missing message when the binary is not installed',
    async () => {
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook devin-pre-tool-use',
        toolPayload(secretFilePath),
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput.permissionDecisionReason).toBe(
        SECRETS_INACTIVE_BINARY_MISSING,
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows when the scanner binary cannot be executed',
    async () => {
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');

      const result = await harness.runWithStdin(
        'hook devin-pre-tool-use',
        toolPayload(secretFilePath),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    { timeout: 15000 },
  );

  it(
    'records the scan with the devin-pre-tool-use caller command',
    async () => {
      harness.state().withSecretsBinaryInstalled().withTelemetryEnabled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.runWithStdin(
        'hook devin-pre-tool-use',
        toolPayload(secretFilePath),
      );

      expect(result.exitCode).toBe(0);
      const [analysisEvent] = readAnalysisEvents(harness.sonarUserHome.path);
      expect(analysisEvent.event_payload.analyzer).toBe('sonar-secrets');
      expect(analysisEvent.event_payload.caller_command).toBe(
        SECRETS_CALLER_COMMANDS.devinPreToolUse,
      );
      expect(analysisEvent.event_payload.exit_code).toBe(EXIT_CODE_SECRETS_FOUND);
      const [statsEvent] = readStatsEvents(harness.sonarUserHome.path);
      expect(statsEvent.caller_command).toBe('devin-pre-tool-use');
      expect(statsEvent.run_trigger).toBe('hooks');
    },
    { timeout: 30000 },
  );
});
