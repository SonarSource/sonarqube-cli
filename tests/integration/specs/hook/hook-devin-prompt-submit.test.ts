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

import { SECRETS_CALLER_COMMANDS } from '@/core/config-constants.ts';

import { readStatsEvents } from '../../../_common/stats-helpers.ts';
import { readAnalysisEvents } from '../../../_common/telemetry-helpers';
import { TestHarness } from '../../harness';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';

const FAKE_SERVER = 'http://localhost:19999';

function promptPayload(prompt: string): string {
  return JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    prompt,
    session_id: 'devin-session',
  });
}

describe('sonar hook devin-prompt-submit', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 and blocks a prompt that contains a secret',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.runWithStdin(
        'hook devin-prompt-submit',
        promptPayload(`my token is ${GITHUB_TEST_TOKEN}`),
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim()) as { decision: string; reason: string };
      expect(output.decision).toBe('block');
      expect(output.reason).toContain('secrets');
    },
    { timeout: 30000 },
  );

  it(
    'records the scan with the shared prompt caller command and the devin caller agent',
    async () => {
      harness.state().withSecretsBinaryInstalled().withTelemetryEnabled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.runWithStdin(
        'hook devin-prompt-submit',
        promptPayload(`my token is ${GITHUB_TEST_TOKEN}`),
        { extraEnv: { DEVIN_PROJECT_DIR: harness.cwd.path } },
      );

      expect(result.exitCode).toBe(0);
      const [analysisEvent] = readAnalysisEvents(harness.sonarUserHome.path);
      expect(analysisEvent.event_payload.caller_command).toBe(
        SECRETS_CALLER_COMMANDS.agentPromptSubmit,
      );
      const [statsEvent] = readStatsEvents(harness.sonarUserHome.path);
      expect(statsEvent.caller_command).toBe(SECRETS_CALLER_COMMANDS.agentPromptSubmit);
      expect(statsEvent.caller_agent).toBe('devin');
    },
    { timeout: 30000 },
  );
});
