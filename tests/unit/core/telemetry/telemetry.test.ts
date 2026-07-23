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

/**
 * Tests for telemetry/index.ts:
 * storeEvent (CliCommandExecuted event building via telemetry-events.ndjson, no-op conditions)
 * flushTelemetry (drains telemetry-events.ndjson, disabled state)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Command } from 'commander';

import * as agentDetector from '@/core/host/agent-detector.ts';
import { DISTRIBUTION } from '@/core/host/distribution.ts';
import * as authResolver from '@/core/server/auth-resolver.ts';
import { ENV_ORG, ENV_SERVER, ENV_TOKEN } from '@/core/server/auth-resolver.ts';
import {
  flushTelemetry,
  setPassthroughSubcommand,
  storeEvent,
  TELEMETRY_FLUSH_MODE_ENV,
} from '@/core/telemetry';
import { resolveTelemetryIdentity } from '@/core/telemetry/identity.ts';
import * as userModule from '@/core/telemetry/user.ts';
import * as ui from '@/core/ui';
import { ENV_DO_NOT_TRACK, ENV_SONAR_USER_HOME } from '@/lib/config-constants.ts';
import * as stateRepository from '@/lib/repository/state-repository.ts';
import type { StoredAnalysisCompletedEvent } from '@/lib/state.ts';
import { getDefaultState } from '@/lib/state.ts';
import * as stateManager from '@/lib/state-manager.ts';

import { restoreEnv } from '../../../_common/isolated-cli-env.ts';
import { readCommandEvents, writeTelemetryEvent } from '../../../_common/telemetry-helpers.ts';
import { mockIdentityGetSafe } from './identity-api-mock.ts';

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

// ─── Setup ────────────────────────────────────────────────────────────────────

let loadStateSpy: ReturnType<typeof spyOn>;
let saveStateSpy: ReturnType<typeof spyOn>;
let getUserIdSpy: ReturnType<typeof spyOn>;
let spawnSpy: ReturnType<typeof spyOn>;
let testDir: string;
// Preserve the preload's isolation env (DO_NOT_TRACK=1) so we don't leak a cleared
// value to later tests, which would re-enable telemetry against the real ~/.sonar.
let savedSonarUserHome: string | undefined;
let savedDoNotTrack: string | undefined;

beforeEach(() => {
  savedSonarUserHome = process.env[ENV_SONAR_USER_HOME];
  savedDoNotTrack = process.env[ENV_DO_NOT_TRACK];
  testDir = mkdtempSync(join(tmpdir(), 'telemetry-test-'));
  process.env[ENV_SONAR_USER_HOME] = testDir;
  // Enable telemetry for these tests; writes land in the isolated testDir.
  delete process.env[ENV_DO_NOT_TRACK];
  loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(getDefaultState('1.0.0'));
  saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => undefined);
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
  restoreEnv(ENV_SONAR_USER_HOME, savedSonarUserHome);
  restoreEnv(ENV_DO_NOT_TRACK, savedDoNotTrack);
  delete process.env[TELEMETRY_FLUSH_MODE_ENV];
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CURSOR_AGENT;
  delete process.env.CURSOR_PROJECT_DIR;
  delete process.env.CURSOR_TRACE_ID;
  delete process.env[ENV_TOKEN];
  delete process.env[ENV_ORG];
  delete process.env[ENV_SERVER];
  delete process.env.SONARQUBE_CLI_SERVER;
  rmSync(testDir, { recursive: true, force: true });
});

// ─── storeEvent ───────────────────────────────────────────────────────────────

describe('storeEvent', () => {
  describe('no-op conditions', () => {
    it('does nothing when running inside a flush worker', async () => {
      process.env[TELEMETRY_FLUSH_MODE_ENV] = '1';
      await storeEvent(makeCommand('auth login'), true);
      expect(loadStateSpy).not.toHaveBeenCalled();
      expect(readCommandEvents(testDir)).toHaveLength(0);
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('does nothing when telemetry is disabled in state', async () => {
      const state = getDefaultState('1.0.0');
      state.telemetry.enabled = false;
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)).toHaveLength(0);
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('does nothing when DO_NOT_TRACK is set', async () => {
      process.env[ENV_DO_NOT_TRACK] = '1';

      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)).toHaveLength(0);
      expect(spawnSpy).not.toHaveBeenCalled();
    });
  });

  describe('event building', () => {
    it('appends one CliCommandExecuted event to telemetry-events.ndjson', async () => {
      await storeEvent(makeCommand('auth login'), true);

      const events = readCommandEvents(testDir);
      expect(events).toHaveLength(1);
    });

    it('sets command to the first word of the command string', async () => {
      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].event_payload.command).toBe('auth');
    });

    it('sets subcommand to the rest of the command string', async () => {
      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].event_payload.subcommand).toBe('login');
    });

    it('sets subcommand to null for single-word commands', async () => {
      await storeEvent(makeCommand('auth'), true);

      expect(readCommandEvents(testDir)[0].event_payload.subcommand).toBeNull();
    });

    it('joins multiple subcommand words with a space', async () => {
      await storeEvent(makeCommand('analyze secrets check'), true);

      const event = readCommandEvents(testDir)[0];
      expect(event.event_payload.command).toBe('analyze');
      expect(event.event_payload.subcommand).toBe('secrets check');
    });

    it('uses the passthrough subcommand stashed on the command, if any', async () => {
      const command = makeCommand('context');
      setPassthroughSubcommand(command, 'get-source');

      await storeEvent(command, true);

      const event = readCommandEvents(testDir)[0];
      expect(event.event_payload.command).toBe('context');
      expect(event.event_payload.subcommand).toBe('get-source');
    });

    it('honors a stashed null subcommand even when the command chain has children', async () => {
      const command = makeCommand('context child');
      setPassthroughSubcommand(command, null);

      await storeEvent(command, true);

      expect(readCommandEvents(testDir)[0].event_payload.subcommand).toBeNull();
    });

    it('sets result to "success" when success is true', async () => {
      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].event_payload.result).toBe('success');
    });

    it('sets result to "failure" when success is false', async () => {
      await storeEvent(makeCommand('auth login'), false);

      expect(readCommandEvents(testDir)[0].event_payload.result).toBe('failure');
    });

    it('sets distribution from the resolved CLI distribution', async () => {
      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].event_payload.distribution).toBe(DISTRIBUTION);
    });

    it('sets event_payload.caller_agent from detectCallerAgent', async () => {
      const spy = spyOn(agentDetector, 'detectCallerAgent').mockReturnValue('claude');
      try {
        await storeEvent(makeCommand('auth login'), true);
        expect(spy).toHaveBeenCalled();
        expect(readCommandEvents(testDir)[0].event_payload.caller_agent).toBe('claude');
      } finally {
        spy.mockRestore();
      }
    });

    it('uses the machine_id returned by getOrCreateUserId', async () => {
      getUserIdSpy.mockReturnValue('my-stable-machine-id');

      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].event_payload.machine_id).toBe('my-stable-machine-id');
    });

    it('uses the cli_installation_id from state.telemetry.installationId', async () => {
      const state = getDefaultState('1.0.0');
      state.telemetry.installationId = 'fixed-install-id';
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].event_payload.cli_installation_id).toBe(
        'fixed-install-id',
      );
    });

    it('sets correct event_type in metadata', async () => {
      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].metadata.event_type).toBe(
        'Analytics.Cli.CliCommandExecuted',
      );
    });

    it('sets source.domain to "CLI" in metadata', async () => {
      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].metadata.source.domain).toBe('CLI');
    });
  });

  describe('connection type mapping', () => {
    it('sets connection_type to "sqc" for a cloud connection', async () => {
      const state = getDefaultState('1.0.0');
      stateManager.addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
      });
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].event_payload.connection_type).toBe('sqc');
    });

    it('sets connection_type to "sqs" for an on-premise connection', async () => {
      const state = getDefaultState('1.0.0');
      stateManager.addOrUpdateConnection(state, 'https://sonarqube.example.com', 'on-premise', {});
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].event_payload.connection_type).toBe('sqs');
    });

    it('sets connection_type to null when there is no active connection', async () => {
      // Default state has no connections
      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].event_payload.connection_type).toBeNull();
    });

    it('includes user_uuid from the active connection', async () => {
      const state = getDefaultState('1.0.0');
      const conn = stateManager.addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
      });
      conn.userUuid = 'user-uuid-abc';
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].event_payload.user_uuid).toBe('user-uuid-abc');
    });

    it('includes organization_uuid_v4 from a cloud connection', async () => {
      const state = getDefaultState('1.0.0');
      const conn = stateManager.addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
      });
      conn.organizationUuidV4 = 'org-uuid-xyz';
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].event_payload.organization_uuid_v4).toBe('org-uuid-xyz');
    });

    it('does not resolve auth from state when the active connection already has UUIDs', async () => {
      const resolveFromStateSpy = spyOn(authResolver, 'resolveFromState');
      const state = getDefaultState('1.0.0');
      const conn = stateManager.addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
      });
      conn.userUuid = 'user-uuid-abc';
      conn.organizationUuidV4 = 'org-uuid-xyz';
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      expect(resolveFromStateSpy).not.toHaveBeenCalled();
      resolveFromStateSpy.mockRestore();
    });

    it('still stores an event when identity enrichment throws', async () => {
      const resolveFromStateSpy = spyOn(authResolver, 'resolveFromState').mockRejectedValue(
        new Error('keychain locked'),
      );
      const state = getDefaultState('1.0.0');
      stateManager.addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
      });
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      const event = readCommandEvents(testDir)[0];
      expect(event.event_payload.connection_type).toBe('sqc');
      expect(event.event_payload.user_uuid).toBeNull();
      expect(event.event_payload.organization_uuid_v4).toBeNull();
      expect(spawnSpy).toHaveBeenCalledTimes(1);

      resolveFromStateSpy.mockRestore();
    });

    it('includes sqs_installation_id from an on-premise connection', async () => {
      const state = getDefaultState('1.0.0');
      const conn = stateManager.addOrUpdateConnection(
        state,
        'https://sonarqube.example.com',
        'on-premise',
        {},
      );
      conn.sqsInstallationId = 'sqs-install-id-123';
      loadStateSpy.mockReturnValue(state);

      await storeEvent(makeCommand('auth login'), true);

      expect(readCommandEvents(testDir)[0].event_payload.sqs_installation_id).toBe(
        'sqs-install-id-123',
      );
    });
  });

  describe('environment-variable authentication identity', () => {
    it('does not warn about partial env vars during storeEvent', async () => {
      const warnSpy = spyOn(ui, 'warn').mockImplementation(() => undefined);
      process.env[ENV_TOKEN] = 'partial-env-token';

      await storeEvent(makeCommand('auth login'), true);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('resolves user_uuid and organization_uuid_v4 via API on first env-auth invocation', async () => {
      process.env[ENV_TOKEN] = 'env-auth-token-2';
      process.env[ENV_ORG] = 'my-org';

      const getSafeSpy = mockIdentityGetSafe({
        user: [{ ok: true, id: 'user-from-api' }],
        org: [{ ok: true, uuidV4: 'org-from-api' }],
      });

      await storeEvent(makeCommand('context'), true);

      const event = readCommandEvents(testDir)[0];
      expect(event.event_payload.user_uuid).toBe('user-from-api');
      expect(event.event_payload.organization_uuid_v4).toBe('org-from-api');
      expect(
        getSafeSpy.mock.calls.filter((call: [string]) => call[0] === '/api/users/current'),
      ).toHaveLength(1);

      getSafeSpy.mockRestore();
    });

    it('does not re-fetch organization_uuid when the API confirms absence', async () => {
      process.env[ENV_TOKEN] = 'env-auth-token-null-org';
      process.env[ENV_ORG] = 'my-org';

      const getSafeSpy = mockIdentityGetSafe({
        user: [{ ok: true, id: 'cached-user' }],
        org: [{ ok: true }],
      });

      await storeEvent(makeCommand('context'), true);
      await storeEvent(makeCommand('analyze'), true);

      expect(
        getSafeSpy.mock.calls.filter((call: [string]) => call[0] === '/api/users/current'),
      ).toHaveLength(1);
      expect(
        getSafeSpy.mock.calls.filter(
          (call: [string]) => call[0] === '/organizations/organizations',
        ),
      ).toHaveLength(1);

      const secondEvent = readCommandEvents(testDir)[1];
      expect(secondEvent.event_payload.user_uuid).toBe('cached-user');
      expect(secondEvent.event_payload.organization_uuid_v4).toBeNull();

      getSafeSpy.mockRestore();
    });

    it('retries user_uuid fetch after a transient API failure', async () => {
      const auth = {
        token: 'env-auth-token-retry-user',
        serverUrl: 'https://sonarcloud.io',
        orgKey: 'my-org',
        connectionType: 'cloud' as const,
      };
      const getSafeSpy = mockIdentityGetSafe({
        user: [{ ok: false }, { ok: true, id: 'user-after-retry' }],
        org: [{ ok: true, uuidV4: 'cached-org' }],
      });

      const first = await resolveTelemetryIdentity(auth);
      const second = await resolveTelemetryIdentity(auth);

      expect(first.user_uuid).toBeNull();
      expect(second.user_uuid).toBe('user-after-retry');
      expect(
        getSafeSpy.mock.calls.filter((call: [string]) => call[0] === '/api/users/current'),
      ).toHaveLength(2);
      expect(
        getSafeSpy.mock.calls.filter(
          (call: [string]) => call[0] === '/organizations/organizations',
        ),
      ).toHaveLength(1);

      getSafeSpy.mockRestore();
    });

    it('resolves user_uuid and sqs_installation_id via API for env-auth on-premise', async () => {
      process.env[ENV_TOKEN] = 'env-auth-server-token';
      process.env[ENV_SERVER] = 'https://sonarqube.example.com';

      const getSafeSpy = mockIdentityGetSafe({
        user: [{ ok: true, id: 'server-user-from-api' }],
        status: [{ ok: true, id: 'sqs-from-api' }],
      });

      await storeEvent(makeCommand('context'), true);

      const event = readCommandEvents(testDir)[0];
      expect(event.event_payload.connection_type).toBe('sqs');
      expect(event.event_payload.user_uuid).toBe('server-user-from-api');
      expect(event.event_payload.sqs_installation_id).toBe('sqs-from-api');

      getSafeSpy.mockRestore();
    });

    it('reuses the disk identity cache on subsequent invocations with the same token', async () => {
      process.env[ENV_TOKEN] = 'env-auth-token-3';
      process.env[ENV_ORG] = 'my-org';

      const getSafeSpy = mockIdentityGetSafe({
        user: [{ ok: true, id: 'cached-user' }],
        org: [{ ok: true, uuidV4: 'cached-org' }],
      });

      await storeEvent(makeCommand('context'), true);
      await storeEvent(makeCommand('analyze'), true);

      expect(
        getSafeSpy.mock.calls.filter((call: [string]) => call[0] === '/api/users/current'),
      ).toHaveLength(1);
      expect(
        getSafeSpy.mock.calls.filter(
          (call: [string]) => call[0] === '/organizations/organizations',
        ),
      ).toHaveLength(1);

      const secondEvent = readCommandEvents(testDir)[1];
      expect(secondEvent.event_payload.user_uuid).toBe('cached-user');
      expect(secondEvent.event_payload.organization_uuid_v4).toBe('cached-org');

      getSafeSpy.mockRestore();
    });
  });

  describe('flush worker', () => {
    it('spawns a flush worker process after storing the event', async () => {
      await storeEvent(makeCommand('auth login'), true);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });

    it('inherits the parent environment and sets the flush worker flag', async () => {
      await storeEvent(makeCommand('auth login'), true);

      const spawnOptions = spawnSpy.mock.calls[0][1] as { env: Record<string, string> };
      expect(spawnOptions.env[TELEMETRY_FLUSH_MODE_ENV]).toBe('1');
      expect(spawnOptions.env[ENV_SONAR_USER_HOME]).toBe(testDir);
    });
  });
});

// ─── flushTelemetry ───────────────────────────────────────────────────────────

describe('flushTelemetry', () => {
  describe('no-op conditions', () => {
    it('does nothing when telemetry is disabled', async () => {
      const state = getDefaultState('1.0.0');
      state.telemetry.enabled = false;
      loadStateSpy.mockReturnValue(state);
      writeTelemetryEvent(testDir, makeCompletedFinding());

      const fetchSpy = mockFetch();
      try {
        await flushTelemetry();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('does nothing when DO_NOT_TRACK is set', async () => {
      process.env[ENV_DO_NOT_TRACK] = '1';
      writeTelemetryEvent(testDir, makeCompletedFinding());

      const fetchSpy = mockFetch();
      try {
        await flushTelemetry();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('findings drain', () => {
    it('drains telemetry-events.ndjson to the telemetry backend', async () => {
      writeTelemetryEvent(testDir, makeCompletedFinding());

      const fetchSpy = mockFetch();
      try {
        await flushTelemetry();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const body = JSON.parse(
          (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
        ) as StoredAnalysisCompletedEvent;
        expect(body.metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
        expect(body.event_payload.findings_count).toBe(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});

function makeCompletedFinding(): StoredAnalysisCompletedEvent {
  return {
    metadata: {
      event_id: 'finding-id',
      source: { domain: 'CLI' },
      event_type: 'Analytics.Cli.CliAnalysisCompleted',
      event_timestamp: String(Date.now()),
    },
    event_payload: {
      cli_installation_id: 'install-id',
      machine_id: 'machine-id',
      cli_version: '1.0.0',
      invocation_id: 'inv-id',
      os: 'linux',
      connection_type: null,
      user_uuid: null,
      organization_uuid_v4: null,
      sqs_installation_id: null,
      caller_agent: null,
      caller_command: 'analyze secrets',
      analyzer: 'sonar-secrets',
      analysis_id: 'analysis-id',
      findings_count: 1,
      exit_code: 51,
      errors_count: 0,
      failures_count: 0,
      scan_duration_ms: 123,
      details: '',
    },
  };
}
