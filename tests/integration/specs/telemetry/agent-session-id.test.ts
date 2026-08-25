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

import { readCommandEvents } from '../../../_common/telemetry-helpers.ts';
import { TestHarness } from '../../harness';

const VALID_TOKEN = 'squ_valid_token';

describe('agent_session_id on CliCommandExecuted', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('records agent_session_id from CLAUDE_CODE_SESSION_ID', async () => {
    const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
    harness.state().withTelemetryEnabled();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('system status', {
      extraEnv: { CLAUDE_CODE_SESSION_ID: 'claude-integration-session' },
    });
    expect(result.exitCode).toBe(0);

    const [commandEvent] = readCommandEvents(harness.sonarUserHome.path);
    expect(commandEvent.event_payload.agent_session_id).toBe('claude-integration-session');
  });

  it('records null agent_session_id when no agent session source is present', async () => {
    const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
    harness.state().withTelemetryEnabled();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('system status');
    expect(result.exitCode).toBe(0);

    const [commandEvent] = readCommandEvents(harness.sonarUserHome.path);
    expect(commandEvent.event_payload.agent_session_id).toBeNull();
  });
});
