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

// Integration tests for `sonar hook cursor-pre-file-read`.
// A deny must exit 2 (Cursor's block signal) and still let postAction commit the
// CliCommandExecuted fact, which the old process.exit() path silently dropped.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { readCommandEvents } from '../../../_common/telemetry-helpers.ts';
import { TestHarness } from '../../harness';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';

// Unreachable server — binary handles connection-refused gracefully and proceeds with scan
const FAKE_SERVER = 'http://localhost:19999';

describe('sonar hook cursor-pre-file-read', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 2 with a deny payload and records CliCommandExecuted when the file contains a secret',
    async () => {
      harness.state().withTelemetryEnabled();
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.runWithStdin(
        'hook cursor-pre-file-read',
        JSON.stringify({
          conversation_id: 'cursor-integration-session',
          file_path: 'secret.js',
          content: `const token = "${GITHUB_TEST_TOKEN}";`,
        }),
      );

      expect(result.exitCode).toBe(2);
      const denyLine = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.includes('"permission"'));
      expect(JSON.parse(denyLine ?? '{}').permission).toBe('deny');

      const [commandEvent] = readCommandEvents(harness.sonarUserHome.path);
      expect(commandEvent.event_payload.command).toBe('hook');
      expect(commandEvent.event_payload.subcommand).toBe('cursor-pre-file-read');
      expect(commandEvent.event_payload.result).toBe('failure');
      expect(commandEvent.event_payload.agent_session_id).toBe('cursor-integration-session');
    },
    { timeout: 30000 },
  );
});
