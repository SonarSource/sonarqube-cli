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

/**
 * Tests for telemetry/index.ts:
 * storeEvent (event building, state persistence, no-op conditions)
 * flushTelemetry (fetch calls, partial failure handling, disabled state)
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as stateManager from '../../src/lib/state-manager.js';
import * as userModule from '../../src/telemetry/user.js';
import { getDefaultState } from '../../src/lib/state.js';
import { storeEvent, flushTelemetry, TELEMETRY_FLUSH_MODE_ENV } from '../../src/telemetry';
import type { CliState, StoredTelemetryEvent } from '../../src/lib/state.js';
import type { Command } from 'commander';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a fake Commander command chain from a space-separated command path.
 * e.g. makeCommand('auth login') produces: root ← auth ← login
 */
function makeCommand(path: string): Command {
  const root = { name: () => '', parent: null } as unknown as Command;
  return path
    .split(' ')
    .reduce((parent, name) => ({ name: () => name, parent }) as unknown as Command, root);
}

function mockFetch(ok = true, status = 200): ReturnType<typeof spyOn> {
  return spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: () => Promise.resolve({}),
    text: () => Promise.resolve('{}'),
  } as Response);
}

function makeStateWithEvents(events: StoredTelemetryEvent[]): CliState {
  const state = getDefaultState('1.0.0');
  state.telemetry.events = events;
  return state;
}

function makeStoredEvent(overrides: Partial<StoredTelemetryEvent> = {}): StoredTelemetryEvent {
  return {
    metadata: {
      event_id: 'test-event-id',
      source: { domain: 'CLI' },
      event_type: 'Analytics.Cli.CliCommandExecuted',
      event_timestamp: String(Date.now()),
    },
    event_payload: {
      cli_installation_id: 'install-id',
      machine_id: 'machine-id',
      cli_version: '1.0.0',
      command: 'auth',
      subcommand: 'login',
      invocation_id: 'inv-id',
      result: 'success',
      os: 'linux',
      connection_type: null,
      user_uuid: null,
      organization_uuid_v4: null,
      sqs_installation_id: null,
    },
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let loadStateSpy: ReturnType<typeof spyOn>;
let saveStateSpy: ReturnType<typeof spyOn>;
let getUserIdSpy: ReturnType<typeof spyOn>;
let spawnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('1.0.0'));
  saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
  getUserIdSpy = spyOn(userModule, 'getOrCreateUserId').mockReturnValue('test-machine-id');
  spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({ unref: () => {} } as ReturnType<
    typeof Bun.spawn
  >);
});

afterEach(() => {
  loadStateSpy.mockRestore();
  saveStateSpy.mockRestore();
  getUserIdSpy.mockRestore();
  spawnSpy.mockRestore();
  delete process.env[TELEMETRY_FLUSH_MODE_ENV];
});

// ─── storeEvent ───────────────────────────────────────────────────────────────

describe('storeEvent', () => {
  describe('no-op conditions', () => {
    it('does nothing when running inside a flush worker', async () => {
      process.env[TELEMETRY_FLUSH_MODE_ENV] = '1';
      await storeEvent(makeCommand('auth login'), true);
      expect(loadStateSpy).not.toHaveBeenCalled();
      expect(saveStateSpy).not.toHaveBeenCalled();
    });

    it('does nothing when telemetry is disabled in state', async () => {
      const state = getDefaultState('1.0.0');
      state.telemetry.enabled = false;
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      expect(saveStateSpy).not.toHaveBeenCalled();
    });
  });

  describe('event building', () => {
    it('appends one event to state.telemetry.events', async () => {
      await storeEvent(makeCommand('auth login'), true);

      const savedState: CliState = saveStateSpy.mock.calls[0][0];
      expect(savedState.telemetry.events).toHaveLength(1);
    });

    it('sets command to the first word of the command string', async () => {
      await storeEvent(makeCommand('auth login'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.command).toBe('auth');
    });

    it('sets subcommand to the rest of the command string', async () => {
      await storeEvent(makeCommand('auth login'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.subcommand).toBe('login');
    });

    it('sets subcommand to null for single-word commands', async () => {
      await storeEvent(makeCommand('auth'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.subcommand).toBeNull();
    });

    it('joins multiple subcommand words with a space', async () => {
      await storeEvent(makeCommand('analyze secrets check'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.command).toBe('analyze');
      expect(event.event_payload.subcommand).toBe('secrets check');
    });

    it('sets result to "success" when success is true', async () => {
      await storeEvent(makeCommand('auth login'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.result).toBe('success');
    });

    it('sets result to "failure" when success is false', async () => {
      await storeEvent(makeCommand('auth login'), false);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.result).toBe('failure');
    });

    it('uses the machine_id returned by getOrCreateUserId', async () => {
      getUserIdSpy.mockReturnValue('my-stable-machine-id');

      await storeEvent(makeCommand('auth login'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.machine_id).toBe('my-stable-machine-id');
    });

    it('uses the cli_installation_id from state.telemetry.installationId', async () => {
      const state = getDefaultState('1.0.0');
      state.telemetry.installationId = 'fixed-install-id';
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.cli_installation_id).toBe('fixed-install-id');
    });

    it('sets correct event_type in metadata', async () => {
      await storeEvent(makeCommand('auth login'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.metadata.event_type).toBe('Analytics.Cli.CliCommandExecuted');
    });

    it('sets source.domain to "CLI" in metadata', async () => {
      await storeEvent(makeCommand('auth login'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.metadata.source.domain).toBe('CLI');
    });
  });

  describe('connection type mapping', () => {
    it('sets connection_type to "sqc" for a cloud connection', async () => {
      const state = getDefaultState('1.0.0');
      stateManager.addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
        keystoreKey: 'sonarcloud.io:my-org',
      });
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.connection_type).toBe('sqc');
    });

    it('sets connection_type to "sqs" for an on-premise connection', async () => {
      const state = getDefaultState('1.0.0');
      stateManager.addOrUpdateConnection(state, 'https://sonarqube.example.com', 'on-premise', {
        keystoreKey: 'sonarqube.example.com',
      });
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.connection_type).toBe('sqs');
    });

    it('sets connection_type to null when there is no active connection', async () => {
      // Default state has no connections
      await storeEvent(makeCommand('auth login'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.connection_type).toBeNull();
    });

    it('includes user_uuid from the active connection', async () => {
      const state = getDefaultState('1.0.0');
      const conn = stateManager.addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
        keystoreKey: 'sonarcloud.io:my-org',
      });
      conn.userUuid = 'user-uuid-abc';
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.user_uuid).toBe('user-uuid-abc');
    });

    it('includes organization_uuid_v4 from a cloud connection', async () => {
      const state = getDefaultState('1.0.0');
      const conn = stateManager.addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
        keystoreKey: 'sonarcloud.io:my-org',
      });
      conn.organizationUuidV4 = 'org-uuid-xyz';
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.organization_uuid_v4).toBe('org-uuid-xyz');
    });

    it('includes sqs_installation_id from an on-premise connection', async () => {
      const state = getDefaultState('1.0.0');
      const conn = stateManager.addOrUpdateConnection(
        state,
        'https://sonarqube.example.com',
        'on-premise',
        {
          keystoreKey: 'sonarqube.example.com',
        },
      );
      conn.sqsInstallationId = 'sqs-install-id-123';
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      const event = saveStateSpy.mock.calls[0][0].telemetry.events[0] as StoredTelemetryEvent;
      expect(event.event_payload.sqs_installation_id).toBe('sqs-install-id-123');
    });
  });

  describe('flush worker', () => {
    it('spawns a flush worker process after storing the event', async () => {
      await storeEvent(makeCommand('auth login'), true);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });

    it('passes TELEMETRY_FLUSH_MODE_ENV to the worker environment', async () => {
      await storeEvent(makeCommand('auth login'), true);

      const spawnCall = spawnSpy.mock.calls[0];
      const spawnOptions = spawnCall[1] as { env: Record<string, string> };
      expect(spawnOptions.env[TELEMETRY_FLUSH_MODE_ENV]).toBe('1');
    });
  });
});

// ─── flushTelemetry ───────────────────────────────────────────────────────────

describe('flushTelemetry', () => {
  describe('no-op conditions', () => {
    it('does nothing when telemetry is disabled', async () => {
      const state = getDefaultState('1.0.0');
      state.telemetry.enabled = false;
      state.telemetry.events = [makeStoredEvent()];
      loadStateSpy.mockReturnValue(state);

      const fetchSpy = mockFetch();
      try {
        await flushTelemetry();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('does nothing when there are no pending events', async () => {
      loadStateSpy.mockReturnValue(makeStateWithEvents([]));

      const fetchSpy = mockFetch();
      try {
        await flushTelemetry();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('sending events', () => {
    it('POSTs each event to the telemetry endpoint', async () => {
      const events = [makeStoredEvent(), makeStoredEvent()];
      loadStateSpy.mockReturnValue(makeStateWithEvents(events));

      const fetchSpy = mockFetch();
      try {
        await flushTelemetry();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('sends with Content-Type application/json header', async () => {
      loadStateSpy.mockReturnValue(makeStateWithEvents([makeStoredEvent()]));

      const fetchSpy = mockFetch();
      try {
        await flushTelemetry();
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('sends with an x-api-key header', async () => {
      loadStateSpy.mockReturnValue(makeStateWithEvents([makeStoredEvent()]));

      const fetchSpy = mockFetch();
      try {
        await flushTelemetry();
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect((init.headers as Record<string, string>)['x-api-key']).toBeTruthy();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('uses POST method', async () => {
      loadStateSpy.mockReturnValue(makeStateWithEvents([makeStoredEvent()]));

      const fetchSpy = mockFetch();
      try {
        await flushTelemetry();
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('POST');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('serialises the event as JSON in the request body', async () => {
      const event = makeStoredEvent();
      loadStateSpy.mockReturnValue(makeStateWithEvents([event]));

      const fetchSpy = mockFetch();
      try {
        await flushTelemetry();
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        const parsed = JSON.parse(init.body as string);
        expect(parsed.metadata.event_type).toBe('Analytics.Cli.CliCommandExecuted');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('omits null values from the serialised body', async () => {
      const event = makeStoredEvent();
      // user_uuid is null in the fixture
      loadStateSpy.mockReturnValue(makeStateWithEvents([event]));

      const fetchSpy = mockFetch();
      try {
        await flushTelemetry();
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        const parsed = JSON.parse(init.body as string);
        expect('user_uuid' in parsed.event_payload).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('state cleanup after flush', () => {
    it('removes sent events from state and saves', async () => {
      loadStateSpy.mockReturnValue(makeStateWithEvents([makeStoredEvent()]));

      const fetchSpy = mockFetch();
      try {
        await flushTelemetry();
        const savedState: CliState = saveStateSpy.mock.calls[0][0];
        expect(savedState.telemetry.events).toHaveLength(0);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('does not save state when no events were sent successfully', async () => {
      loadStateSpy.mockReturnValue(makeStateWithEvents([makeStoredEvent()]));

      const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
      try {
        await flushTelemetry();
        expect(saveStateSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('removes only successfully sent events when some fetches fail', async () => {
      const events = [makeStoredEvent(), makeStoredEvent(), makeStoredEvent()];
      loadStateSpy.mockReturnValue(makeStateWithEvents(events));

      // First call succeeds, second fails, third succeeds
      const fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: true } as Response)
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ ok: true } as Response);
      try {
        await flushTelemetry();
        const savedState: CliState = saveStateSpy.mock.calls[0][0];
        expect(savedState.telemetry.events).toHaveLength(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
