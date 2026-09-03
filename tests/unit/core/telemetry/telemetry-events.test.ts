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
 * Tests for telemetry/telemetry-events.ts:
 *   emitAnalysisCompleted — CliAnalysisCompleted envelope + telemetry gate
 *   flushTelemetryEvents  — atomic rename, retention cap, send, re-queue, concurrent safety
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { AnalysisCompletedPayload } from '@/commands/analyze/analysis-completed.ts';
import { scanAndEmitSecrets } from '@/commands/analyze/secrets.ts';
import { SECRETS_CALLER_COMMANDS } from '@/commands/analyze/secrets-analysis-telemetry.ts';
import { SQAA_ANALYZE_AGENTIC_CALLER_COMMAND } from '@/commands/analyze/sqaa-analysis-telemetry.ts';
import type { IntegrationConfiguredPayload } from '@/commands/integrate/_common/integrate-telemetry.ts';
import { commitTelemetryFacts } from '@/commands/telemetry-facts.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { ENV_SONAR_USER_HOME, TELEMETRY_ENDPOINT } from '@/core/config-constants.ts';
import { NetworkConfigError } from '@/core/errors.ts';
import * as networkConfig from '@/core/host/connectivity/network-config.ts';
import { DISTRIBUTION } from '@/core/host/distribution.ts';
import * as agentDetector from '@/core/host/environment/agent-detector.ts';
import type { SpawnResult } from '@/core/process/process.ts';
import * as fetchModule from '@/core/server/fetch.ts';
import type { TelemetryEventIdentityPayload } from '@/core/state/state.ts';
import * as stateManager from '@/core/state/state-manager.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import { emitTelemetryEvent, flushTelemetryEvents } from '@/core/telemetry/telemetry-events.ts';
import * as userModule from '@/core/telemetry/user.ts';

import { restoreEnv } from '../../../_common/isolated-cli-env.ts';
import {
  makeTelemetryState,
  readAnalysisEvents,
  readCommandEvents,
  readIntegrationEvents,
  type StoredAnalysisCompletedEvent,
  telemetryEventsPath,
  writeTelemetryEvent,
} from '../../../_common/telemetry-helpers.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type AnalysisCompletedEventPayload = TelemetryEventIdentityPayload &
  AnalysisCompletedPayload &
  Record<string, unknown>;

async function emitAnalysisCompleted(
  auth: ResolvedAuth,
  fields: AnalysisCompletedPayload,
  options?: { agentSessionId?: string | null },
): Promise<void> {
  await emitTelemetryEvent('CliAnalysisCompleted', fields, { auth, ...options });
}

async function emitIntegrationConfigured(
  auth: ResolvedAuth,
  fields: IntegrationConfiguredPayload,
): Promise<void> {
  await emitTelemetryEvent('CliIntegrationConfigured', fields, { auth });
}

async function emitCommandExecuted(fields: object): Promise<void> {
  await emitTelemetryEvent('CliCommandExecuted', fields);
}

function makeIdentityPayload() {
  return {
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
    agent_session_id: null,
  } as const;
}

function makeAnalysisCompletedPayload(
  overrides: Partial<AnalysisCompletedPayload> = {},
): AnalysisCompletedPayload {
  return {
    caller_command: SQAA_ANALYZE_AGENTIC_CALLER_COMMAND,
    analyzer: 'sqaa',
    analysis_id: 'analysis-id-123',
    findings_count: 0,
    exit_code: null,
    errors_count: 0,
    failures_count: 0,
    scan_duration_ms: 456,
    details: '',
    ...overrides,
  };
}

function makeCompletedPayload(
  overrides: Partial<AnalysisCompletedEventPayload> = {},
): AnalysisCompletedEventPayload {
  return {
    ...makeIdentityPayload(),
    ...makeAnalysisCompletedPayload(),
    ...overrides,
  };
}

function makeStoredCompletedEvent(
  overrides: Partial<AnalysisCompletedEventPayload> = {},
): StoredAnalysisCompletedEvent {
  return {
    metadata: {
      event_id: 'completed-id',
      source: { domain: 'CLI' },
      event_type: 'Analytics.Cli.CliAnalysisCompleted',
      event_timestamp: String(Date.now()),
    },
    event_payload: makeCompletedPayload(overrides),
  };
}

function mockFetch(ok = true): ReturnType<typeof spyOn> {
  return spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: () => Promise.resolve({}),
    text: () => Promise.resolve('{}'),
  } as Response);
}

const AUTH: ResolvedAuth = {
  connectionType: 'cloud',
  serverUrl: 'https://sonarcloud.io',
  token: 'test-token',
  orgKey: 'my-org',
};

// ─── Setup ────────────────────────────────────────────────────────────────────

const AGENT_SESSION_ENV_KEYS = [
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'GEMINI_SESSION_ID',
] as const;

let testSonarUserHome: string;
const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];

let loadStateSpy: ReturnType<typeof spyOn>;
let getConnectionSpy: ReturnType<typeof spyOn>;
let getUserIdSpy: ReturnType<typeof spyOn>;
let detectAgentSpy: ReturnType<typeof spyOn>;
let defaultFetchSpy: ReturnType<typeof spyOn>;
let savedDoNotTrack: string | undefined;
let savedAgentSessionEnv: Partial<Record<(typeof AGENT_SESSION_ENV_KEYS)[number], string>>;

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'cli-telemetry-events-test-'));
  process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;

  savedDoNotTrack = process.env.DO_NOT_TRACK;
  delete process.env.DO_NOT_TRACK;

  savedAgentSessionEnv = {};
  for (const key of AGENT_SESSION_ENV_KEYS) {
    savedAgentSessionEnv[key] = process.env[key];
    delete process.env[key];
  }

  loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeTelemetryState());
  getConnectionSpy = spyOn(stateManager, 'getActiveConnection').mockReturnValue(undefined);
  getUserIdSpy = spyOn(userModule, 'getOrCreateUserId').mockReturnValue('machine-id');
  detectAgentSpy = spyOn(agentDetector, 'detectCallerAgent').mockReturnValue(null);
  // Emitting an event with a cloud/server auth but no seeded connection triggers
  // identity enrichment, which otherwise hits the real network. Stub fetch by
  // default so no test in this file depends on network reachability (a real call
  // fails fast locally but hangs to a 5s timeout in CI). Tests that assert on the
  // telemetry HTTP flush install their own fetch spy, which shadows this one.
  defaultFetchSpy = mockFetch();
});

afterEach(async () => {
  if (savedDoNotTrack !== undefined) {
    process.env.DO_NOT_TRACK = savedDoNotTrack;
  } else {
    delete process.env.DO_NOT_TRACK;
  }

  for (const key of AGENT_SESSION_ENV_KEYS) {
    restoreEnv(key, savedAgentSessionEnv[key]);
  }

  loadStateSpy.mockRestore();
  getConnectionSpy.mockRestore();
  getUserIdSpy.mockRestore();
  detectAgentSpy.mockRestore();
  defaultFetchSpy.mockRestore();

  await rm(testSonarUserHome, { recursive: true, force: true });
  if (previousSonarUserHome === undefined) {
    delete process.env[ENV_SONAR_USER_HOME];
  } else {
    process.env[ENV_SONAR_USER_HOME] = previousSonarUserHome;
  }
});

// ─── emitAnalysisCompleted ─────────────────────────────────────────────────────

describe('emitAnalysisCompleted()', () => {
  it('writes a valid CliAnalysisCompleted envelope', async () => {
    await emitAnalysisCompleted(
      AUTH,
      makeAnalysisCompletedPayload({ findings_count: 2, exit_code: 51 }),
    );

    const [event] = readAnalysisEvents(testSonarUserHome);
    expect(event.metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
    const completedEvent = event;
    expect(completedEvent.event_payload.analyzer).toBe('sqaa');
    expect(completedEvent.event_payload.findings_count).toBe(2);
    expect(completedEvent.event_payload.exit_code).toBe(51);
    expect(completedEvent.event_payload.caller_command).toBe(SQAA_ANALYZE_AGENTIC_CALLER_COMMAND);
  });

  it('does not append when telemetry is disabled', async () => {
    loadStateSpy.mockReturnValue(makeTelemetryState(false));

    await emitAnalysisCompleted(AUTH, makeAnalysisCompletedPayload());

    expect(readAnalysisEvents(testSonarUserHome)).toHaveLength(0);
  });

  it('does not append when installationId is absent', async () => {
    const stateWithoutId = makeTelemetryState();
    stateWithoutId.telemetry.installationId = undefined;
    loadStateSpy.mockReturnValue(stateWithoutId);

    await emitAnalysisCompleted(AUTH, makeAnalysisCompletedPayload());

    expect(readAnalysisEvents(testSonarUserHome)).toHaveLength(0);
  });

  it('sets connection_type to sqc for cloud connections', async () => {
    await emitAnalysisCompleted(
      { ...AUTH, connectionType: 'cloud' },
      makeAnalysisCompletedPayload(),
    );

    const [event] = readAnalysisEvents(testSonarUserHome);
    expect(event.event_payload.connection_type).toBe('sqc');
  });

  it('sets connection_type to sqs for server connections', async () => {
    await emitAnalysisCompleted(
      { ...AUTH, connectionType: 'on-premise' },
      makeAnalysisCompletedPayload(),
    );

    const [event] = readAnalysisEvents(testSonarUserHome);
    expect(event.event_payload.connection_type).toBe('sqs');
  });

  it('includes connection identity fields from the active connection', async () => {
    getConnectionSpy.mockReturnValue({
      id: 'conn-id',
      type: 'cloud',
      serverUrl: 'https://sonarcloud.io',
      orgKey: 'my-org',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
      userUuid: 'user-uuid-abc',
      organizationUuidV4: 'org-uuid-xyz',
      sqsInstallationId: 'sqs-install-id-123',
    });

    await emitAnalysisCompleted(AUTH, makeAnalysisCompletedPayload());

    const payload = readAnalysisEvents(testSonarUserHome)[0].event_payload;
    expect(payload.user_uuid).toBe('user-uuid-abc');
    expect(payload.organization_uuid_v4).toBe('org-uuid-xyz');
    expect(payload.sqs_installation_id).toBe('sqs-install-id-123');
  });

  it('sets caller_agent from detectCallerAgent', async () => {
    detectAgentSpy.mockReturnValue('cursor');

    await emitAnalysisCompleted(AUTH, makeAnalysisCompletedPayload());

    const payload = readAnalysisEvents(testSonarUserHome)[0].event_payload;
    expect(payload.caller_agent).toBe('cursor');
  });

  it('sets agent_session_id from identityOptions', async () => {
    await emitAnalysisCompleted(AUTH, makeAnalysisCompletedPayload(), {
      agentSessionId: 'sess-abc',
    });

    const payload = readAnalysisEvents(testSonarUserHome)[0].event_payload;
    expect(payload.agent_session_id).toBe('sess-abc');
  });

  it('sets agent_session_id from env when identityOptions omit a session', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-session';

    await emitAnalysisCompleted(AUTH, makeAnalysisCompletedPayload());

    const payload = readAnalysisEvents(testSonarUserHome)[0].event_payload;
    expect(payload.agent_session_id).toBe('env-session');
  });

  it('prefers identityOptions.agentSessionId over env', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-session';

    await emitAnalysisCompleted(AUTH, makeAnalysisCompletedPayload(), {
      agentSessionId: 'hook-session',
    });

    const payload = readAnalysisEvents(testSonarUserHome)[0].event_payload;
    expect(payload.agent_session_id).toBe('hook-session');
  });

  it('sets agent_session_id to null when identityOptions and env omit a session', async () => {
    await emitAnalysisCompleted(AUTH, makeAnalysisCompletedPayload());

    const payload = readAnalysisEvents(testSonarUserHome)[0].event_payload;
    expect(payload.agent_session_id).toBeNull();
  });

  it('creates the telemetry directory if it does not exist', async () => {
    const telemetryDir = join(testSonarUserHome, 'sonarqube-cli', 'telemetry');
    expect(existsSync(telemetryDir)).toBe(false);

    await emitAnalysisCompleted(AUTH, makeAnalysisCompletedPayload());

    expect(existsSync(telemetryDir)).toBe(true);
  });
});

// ─── emitIntegrationConfigured ─────────────────────────────────────────────────

function makeIntegrationConfiguredPayload(
  overrides: Partial<IntegrationConfiguredPayload> = {},
): IntegrationConfiguredPayload {
  return {
    integration_id: 'claude',
    repo_id: 'a'.repeat(64),
    features_installed: ['sonar-secrets-hooks'],
    features_declined: ['sqaa-instructions'],
    features_uninstalled: ['mcp-server'],
    is_global: false,
    is_interactive: true,
    is_from_router: false,
    ...overrides,
  };
}

describe('emitIntegrationConfigured()', () => {
  it('writes a valid CliIntegrationConfigured envelope', async () => {
    await emitIntegrationConfigured(
      AUTH,
      makeIntegrationConfiguredPayload({
        integration_id: 'git',
        features_installed: ['pre-commit-hook', 'pre-commit-secrets'],
        features_declined: ['pre-commit-dependency-risks'],
        features_uninstalled: [],
        is_from_router: true,
      }),
    );

    const [event] = readIntegrationEvents(testSonarUserHome);
    expect(event.metadata.event_type).toBe('Analytics.Cli.CliIntegrationConfigured');
    const configured = event;
    expect(configured.event_payload.integration_id).toBe('git');
    expect(configured.event_payload.features_installed).toEqual([
      'pre-commit-hook',
      'pre-commit-secrets',
    ]);
    expect(configured.event_payload.features_declined).toEqual(['pre-commit-dependency-risks']);
    expect(configured.event_payload.features_uninstalled).toEqual([]);
    expect(configured.event_payload.is_from_router).toBe(true);
    // Identity base is merged in.
    expect(configured.event_payload.cli_installation_id).toBe('install-id');
    expect(configured.event_payload.agent_session_id).toBeNull();
  });

  it('sets agent_session_id from env when a session is present', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-integrate-session';

    await emitIntegrationConfigured(AUTH, makeIntegrationConfiguredPayload());

    const [event] = readIntegrationEvents(testSonarUserHome);
    expect(event.event_payload.agent_session_id).toBe('env-integrate-session');
  });

  it('does not append when telemetry is disabled', async () => {
    loadStateSpy.mockReturnValue(makeTelemetryState(false));

    await emitIntegrationConfigured(AUTH, makeIntegrationConfiguredPayload());

    expect(readIntegrationEvents(testSonarUserHome)).toHaveLength(0);
  });
});

// ─── emitCommandExecuted ───────────────────────────────────────────────────────

describe('emitCommandExecuted()', () => {
  it('writes a valid CliCommandExecuted envelope with identity base merged in', async () => {
    await emitCommandExecuted({
      command: 'auth',
      subcommand: 'login',
      result: 'success',
      distribution: DISTRIBUTION,
      project_uuid: null,
    });

    const [event] = readCommandEvents(testSonarUserHome);
    expect(event.metadata.event_type).toBe('Analytics.Cli.CliCommandExecuted');
    expect(event.event_payload.command).toBe('auth');
    expect(event.event_payload.subcommand).toBe('login');
    expect(event.event_payload.result).toBe('success');
    expect(event.event_payload.distribution).toBe(DISTRIBUTION);
    // Identity base is merged in.
    expect(event.event_payload.cli_installation_id).toBe('install-id');
    expect(event.event_payload.machine_id).toBe('machine-id');
    // No project resolved for this command.
    expect(event.event_payload.project_uuid).toBeNull();
  });

  it('carries a resolved project_uuid through for opt-in commands', async () => {
    await emitCommandExecuted({
      command: 'analyze',
      subcommand: 'dependency-risks',
      result: 'success',
      distribution: DISTRIBUTION,
      project_uuid: 'AYmy-projectlegacy',
    });

    const [event] = readCommandEvents(testSonarUserHome);
    expect(event.event_payload.project_uuid).toBe('AYmy-projectlegacy');
  });

  it('does not append when telemetry is disabled', async () => {
    loadStateSpy.mockReturnValue(makeTelemetryState(false));

    await emitCommandExecuted({
      command: 'auth',
      subcommand: null,
      result: 'success',
      distribution: DISTRIBUTION,
      project_uuid: null,
    });

    expect(readCommandEvents(testSonarUserHome)).toHaveLength(0);
  });

  it('does not append when installationId is absent', async () => {
    const stateWithoutId = makeTelemetryState();
    stateWithoutId.telemetry.installationId = undefined;
    loadStateSpy.mockReturnValue(stateWithoutId);

    await emitCommandExecuted({
      command: 'auth',
      subcommand: null,
      result: 'success',
      distribution: DISTRIBUTION,
      project_uuid: null,
    });

    expect(readCommandEvents(testSonarUserHome)).toHaveLength(0);
  });
});

// ─── flushTelemetryEvents ───────────────────────────────────────────────────────

describe('flushTelemetryEvents()', () => {
  it('does nothing when telemetry-events.ndjson does not exist', async () => {
    const fetchSpy = mockFetch();
    try {
      await flushTelemetryEvents(Date.now() + 60_000);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('POSTs each event to the telemetry endpoint', async () => {
    writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent({ analysis_id: 'run-a' }));
    writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent({ analysis_id: 'run-b' }));

    const fetchSpy = mockFetch();
    try {
      await flushTelemetryEvents(Date.now() + 60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('deletes telemetry-events.ndjson after draining', async () => {
    writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent());

    const fetchSpy = mockFetch();
    try {
      await flushTelemetryEvents(Date.now() + 60_000);
      expect(existsSync(telemetryEventsPath(testSonarUserHome))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('sends with correct headers and POST method', async () => {
    writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent());

    const fetchSpy = mockFetch();
    try {
      await flushTelemetryEvents(Date.now() + 60_000);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect((init.headers as Record<string, string>)['x-api-key']).toBeTruthy();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('serialises the analysis event in the request body', async () => {
    writeTelemetryEvent(
      testSonarUserHome,
      makeStoredCompletedEvent({ findings_count: 3, exit_code: 51 }),
    );

    const fetchSpy = mockFetch();
    try {
      await flushTelemetryEvents(Date.now() + 60_000);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const parsed = JSON.parse(init.body as string) as StoredAnalysisCompletedEvent;
      expect(parsed.metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
      expect(parsed.event_payload.findings_count).toBe(3);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('omits null values from the serialised body', async () => {
    writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent());

    const fetchSpy = mockFetch();
    try {
      await flushTelemetryEvents(Date.now() + 60_000);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const parsed = JSON.parse(init.body as string) as StoredAnalysisCompletedEvent;
      expect('user_uuid' in parsed.event_payload).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('discards events older than 7 days', async () => {
    const eightDaysAgo = String(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const recentTs = String(Date.now());

    const staleEvent: StoredAnalysisCompletedEvent = {
      metadata: {
        event_id: 'stale-id',
        source: { domain: 'CLI' },
        event_type: 'Analytics.Cli.CliAnalysisCompleted',
        event_timestamp: eightDaysAgo,
      },
      event_payload: makeCompletedPayload({ analysis_id: 'stale-run' }),
    };
    const freshEvent: StoredAnalysisCompletedEvent = {
      metadata: {
        event_id: 'fresh-id',
        source: { domain: 'CLI' },
        event_type: 'Analytics.Cli.CliAnalysisCompleted',
        event_timestamp: recentTs,
      },
      event_payload: makeCompletedPayload({ analysis_id: 'fresh-run' }),
    };

    const telemetryDir = join(testSonarUserHome, 'sonarqube-cli', 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    writeFileSync(
      telemetryEventsPath(testSonarUserHome),
      [JSON.stringify(staleEvent), JSON.stringify(freshEvent)].join('\n') + '\n',
    );

    const fetchSpy = mockFetch();
    try {
      await flushTelemetryEvents(Date.now() + 60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const parsed = JSON.parse(init.body as string) as StoredAnalysisCompletedEvent;
      expect(parsed.event_payload.analysis_id).toBe('fresh-run');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('discards events with a non-numeric event_timestamp', async () => {
    const telemetryDir = join(testSonarUserHome, 'sonarqube-cli', 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    const nanTsEvent: StoredAnalysisCompletedEvent = {
      metadata: {
        event_id: 'nan-id',
        source: { domain: 'CLI' },
        event_type: 'Analytics.Cli.CliAnalysisCompleted',
        event_timestamp: 'not-a-number',
      },
      event_payload: makeCompletedPayload(),
    };
    writeFileSync(telemetryEventsPath(testSonarUserHome), JSON.stringify(nanTsEvent) + '\n');

    const fetchSpy = mockFetch();
    try {
      await flushTelemetryEvents(Date.now() + 60_000);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('skips malformed lines without throwing', async () => {
    const telemetryDir = join(testSonarUserHome, 'sonarqube-cli', 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    const validEvent = makeStoredCompletedEvent({ analysis_id: 'valid-run' });
    writeFileSync(
      telemetryEventsPath(testSonarUserHome),
      ['not-valid-json', JSON.stringify(validEvent), '{broken'].join('\n') + '\n',
    );

    const fetchSpy = mockFetch();
    try {
      await flushTelemetryEvents(Date.now() + 60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('re-queues events that fail to send for the next flush', async () => {
    writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent({ analysis_id: 'run-a' }));
    writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent({ analysis_id: 'run-b' }));

    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ ok: true } as Response);

    try {
      await flushTelemetryEvents(Date.now() + 60_000);
      const requeued = readAnalysisEvents(testSonarUserHome);
      expect(requeued).toHaveLength(1);
      expect(requeued[0].metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
      expect(requeued[0].event_payload.analysis_id).toBe('run-a');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('re-queues all events when the deadline has already passed', async () => {
    writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent({ analysis_id: 'run-a' }));
    writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent({ analysis_id: 'run-b' }));

    const fetchSpy = mockFetch();
    try {
      await flushTelemetryEvents(Date.now() - 1);
      expect(fetchSpy).not.toHaveBeenCalled();
      const requeued = readAnalysisEvents(testSonarUserHome);
      expect(requeued).toHaveLength(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('is a no-op when a concurrent flush already renamed the file (ENOENT race)', async () => {
    writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent());

    const path = telemetryEventsPath(testSonarUserHome);
    const { renameSync: realRename } = await import('node:fs');
    let calls = 0;
    const renameSpy = spyOn(await import('node:fs'), 'renameSync').mockImplementation(
      (...args: Parameters<typeof realRename>) => {
        calls++;
        if (calls === 1) {
          realRename(...args);
          realRename(args[1], path);
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return realRename(...args);
      },
    );

    const fetchSpy = mockFetch();
    try {
      await flushTelemetryEvents(Date.now() + 60_000);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('silently swallows individual send failures', async () => {
    writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent({ analysis_id: 'run-a' }));
    writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent({ analysis_id: 'run-b' }));

    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ ok: true } as Response);

    try {
      let threw = false;
      try {
        await flushTelemetryEvents(Date.now() + 60_000);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  describe('per-request timeout', () => {
    it('caps each request at 20s even when the flush deadline is far away', async () => {
      writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent());

      const initSpy = spyOn(fetchModule, 'buildRequest');
      const fetchSpy = mockFetch();
      try {
        await flushTelemetryEvents(Date.now() + 60_000);
        expect(initSpy.mock.calls[0][2]).toBe(20_000);
      } finally {
        fetchSpy.mockRestore();
        initSpy.mockRestore();
      }
    });

    it('uses the remaining deadline when it is shorter than the cap', async () => {
      writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent());

      const initSpy = spyOn(fetchModule, 'buildRequest');
      const fetchSpy = mockFetch();
      try {
        await flushTelemetryEvents(Date.now() + 2_000);
        const timeout = initSpy.mock.calls[0][2];
        expect(timeout).toBeGreaterThan(0);
        expect(timeout).toBeLessThanOrEqual(2_000);
      } finally {
        fetchSpy.mockRestore();
        initSpy.mockRestore();
      }
    });
  });

  describe('network configuration', () => {
    it('sends through the resolved proxy and TLS options', async () => {
      writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent());

      const networkSpy = spyOn(networkConfig, 'buildFetchNetworkOptions').mockReturnValue({
        proxy: 'http://proxy.internal:3128',
      });
      const fetchSpy = mockFetch();
      try {
        await flushTelemetryEvents(Date.now() + 60_000);
        expect(networkSpy).toHaveBeenCalledWith(TELEMETRY_ENDPOINT);
        const init = fetchSpy.mock.calls[0][1] as RequestInit & { proxy?: string };
        expect(init.proxy).toBe('http://proxy.internal:3128');
      } finally {
        fetchSpy.mockRestore();
        networkSpy.mockRestore();
      }
    });

    it('resolves the network options for every request in the batch', async () => {
      writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent({ analysis_id: 'run-a' }));
      writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent({ analysis_id: 'run-b' }));

      const networkSpy = spyOn(networkConfig, 'buildFetchNetworkOptions').mockReturnValue({});
      const fetchSpy = mockFetch();
      try {
        await flushTelemetryEvents(Date.now() + 60_000);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(networkSpy).toHaveBeenCalledTimes(2);
      } finally {
        fetchSpy.mockRestore();
        networkSpy.mockRestore();
      }
    });

    it('requeues the whole batch instead of bypassing an unusable network config', async () => {
      writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent({ analysis_id: 'run-a' }));
      writeTelemetryEvent(testSonarUserHome, makeStoredCompletedEvent({ analysis_id: 'run-b' }));

      const networkSpy = spyOn(networkConfig, 'buildFetchNetworkOptions').mockImplementation(() => {
        throw new NetworkConfigError('unreadable client certificate');
      });
      const fetchSpy = mockFetch();
      try {
        await flushTelemetryEvents(Date.now() + 60_000);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(readAnalysisEvents(testSonarUserHome)).toHaveLength(2);
        // The batch stops on the first unusable config instead of retrying per event.
        expect(networkSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
        networkSpy.mockRestore();
      }
    });
  });
});

// ─── scanAndEmitSecrets ────────────────────────────────────────────────────────

// Resolves a spawn as if sonar-secrets ran to completion with the given exit code / stdout.
function resolvedRun(exitCode: number | null, stdout: string): () => Promise<SpawnResult> {
  return () => Promise.resolve({ exitCode, stdout, stderr: '' });
}

function makeCtx() {
  return new CommandInvocationContext();
}

describe('scanAndEmitSecrets() — emitted event fields', () => {
  it('does nothing when telemetry is disabled', async () => {
    loadStateSpy.mockReturnValue(makeTelemetryState(false));
    const ctx = makeCtx();
    await scanAndEmitSecrets(
      SECRETS_CALLER_COMMANDS.analyzeSecrets,
      AUTH,
      resolvedRun(0, '{}'),
      ctx,
    );
    await commitTelemetryFacts(ctx.telemetryFacts());
    expect(readAnalysisEvents(testSonarUserHome)).toHaveLength(0);
  });

  it('emits a single CliAnalysisCompleted with details "" on a clean scan (exit 0, no issues)', async () => {
    const ctx = makeCtx();
    await scanAndEmitSecrets(
      SECRETS_CALLER_COMMANDS.analyzeSecrets,
      AUTH,
      resolvedRun(0, JSON.stringify({ issues: [] })),
      ctx,
    );
    await commitTelemetryFacts(ctx.telemetryFacts());

    const lines = readAnalysisEvents(testSonarUserHome);
    expect(lines).toHaveLength(1);
    expect(lines[0].metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
    const completed = lines[0];
    expect(completed.event_payload.failures_count).toBe(0);
    expect(completed.event_payload.exit_code).toBe(0);
    expect(completed.event_payload.findings_count).toBe(0);
    expect(completed.event_payload.details).toBe('');
    expect(typeof completed.event_payload.scan_duration_ms).toBe('number');
    expect(completed.event_payload.scan_duration_ms).toBeGreaterThanOrEqual(0);
    expect(completed.event_payload.caller_command).toBe(SECRETS_CALLER_COMMANDS.analyzeSecrets);
    expect(completed.event_payload.analyzer).toBe('sonar-secrets');
  });

  it('emits a single CliAnalysisCompleted with populated details when secrets found (exit 51)', async () => {
    const stdout = JSON.stringify({
      issues: [
        { ruleKey: 'secrets:S6290', description: 'AWS key', file: 'src/config.ts' },
        { ruleKey: 'secrets:S6290', description: 'AWS key (2)', file: 'src/config.ts' },
        { ruleKey: 'secrets:S1234', description: 'Other', file: 'src/other.ts' },
      ],
    });
    const ctx = makeCtx();
    await scanAndEmitSecrets(
      SECRETS_CALLER_COMMANDS.gitPreCommit,
      AUTH,
      resolvedRun(51, stdout),
      ctx,
    );
    await commitTelemetryFacts(ctx.telemetryFacts());

    const lines = readAnalysisEvents(testSonarUserHome);
    expect(lines).toHaveLength(1);

    const completed = lines[0];
    expect(completed.metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
    expect(completed.event_payload.failures_count).toBe(0);
    expect(completed.event_payload.exit_code).toBe(51);
    expect(completed.event_payload.findings_count).toBe(3);
    expect(completed.event_payload.caller_command).toBe(SECRETS_CALLER_COMMANDS.gitPreCommit);

    const details = JSON.parse(completed.event_payload.details) as {
      counts_by_rule: Record<string, number>;
      files_with_findings_count: number;
      source: string;
    };
    expect(details.counts_by_rule['secrets:S6290']).toBe(2);
    expect(details.counts_by_rule['secrets:S1234']).toBe(1);
    expect(details.files_with_findings_count).toBe(2);
    expect(details.source).toBe('files');
  });

  it('sets source to stdin and files_with_findings_count to 0 when no file paths in issues', async () => {
    const stdout = JSON.stringify({
      issues: [{ ruleKey: 'secrets:S6290', description: 'AWS key in prompt' }],
    });
    const ctx = makeCtx();
    await scanAndEmitSecrets(
      SECRETS_CALLER_COMMANDS.agentPromptSubmit,
      AUTH,
      resolvedRun(51, stdout),
      ctx,
    );
    await commitTelemetryFacts(ctx.telemetryFacts());

    const lines = readAnalysisEvents(testSonarUserHome);
    const completed = lines[0];
    const details = JSON.parse(completed.event_payload.details) as {
      files_with_findings_count: number;
      source: string;
    };
    expect(details.files_with_findings_count).toBe(0);
    expect(details.source).toBe('stdin');
  });

  it('emits only CliAnalysisCompleted with failures_count 1 for a non-clean, non-findings exit code', async () => {
    const ctx = makeCtx();
    await scanAndEmitSecrets(
      SECRETS_CALLER_COMMANDS.copilotPreToolUse,
      AUTH,
      resolvedRun(2, '{}'),
      ctx,
    );
    await commitTelemetryFacts(ctx.telemetryFacts());

    const lines = readAnalysisEvents(testSonarUserHome);
    expect(lines).toHaveLength(1);
    const completed = lines[0];
    expect(completed.event_payload.failures_count).toBe(1);
    expect(completed.event_payload.findings_count).toBe(0);
    expect(completed.event_payload.exit_code).toBe(2);
  });

  it('reports a resolved null exitCode as exit_code null with failures_count 1 (no coercion)', async () => {
    const ctx = makeCtx();
    await scanAndEmitSecrets(
      SECRETS_CALLER_COMMANDS.agentPromptSubmit,
      AUTH,
      resolvedRun(null, '{}'),
      ctx,
    );
    await commitTelemetryFacts(ctx.telemetryFacts());

    const lines = readAnalysisEvents(testSonarUserHome);
    expect(lines).toHaveLength(1);
    const completed = lines[0];
    expect(completed.event_payload.failures_count).toBe(1);
    expect(completed.event_payload.exit_code).toBeNull();
  });

  it('records errors_count from the errors field in stdout, independent of failures_count', async () => {
    const stdout = JSON.stringify({ issues: [], errors: ['auth failed', 'partial scan'] });
    // exit 2: run failed (failures_count 1) AND reported errors[] (errors_count 2) — not mutually exclusive
    const ctx = makeCtx();
    await scanAndEmitSecrets(
      SECRETS_CALLER_COMMANDS.analyzeSecrets,
      AUTH,
      resolvedRun(2, stdout),
      ctx,
    );
    await commitTelemetryFacts(ctx.telemetryFacts());

    const lines = readAnalysisEvents(testSonarUserHome);
    const completed = lines[0];
    expect(completed.event_payload.errors_count).toBe(2);
    expect(completed.event_payload.failures_count).toBe(1);
  });
});

describe('scanAndEmitSecrets() — wrapper behavior', () => {
  it('emits a completed event and returns the spawn result + parsed output on success', async () => {
    const result: SpawnResult = {
      exitCode: 51,
      stdout: JSON.stringify({ issues: [{ ruleKey: 'secrets:S6290', description: 'AWS key' }] }),
      stderr: '',
    };
    const ctx = makeCtx();
    const out = await scanAndEmitSecrets(
      SECRETS_CALLER_COMMANDS.gitPreCommit,
      AUTH,
      () => Promise.resolve(result),
      ctx,
    );
    await commitTelemetryFacts(ctx.telemetryFacts());

    expect(out.result).toBe(result);
    expect(out.parsed.issues).toHaveLength(1);

    const lines = readAnalysisEvents(testSonarUserHome);
    // a single Completed event carrying details (findings present)
    expect(lines).toHaveLength(1);
    const completed = lines[0];
    expect(completed.event_payload.failures_count).toBe(0);
    expect(completed.event_payload.exit_code).toBe(51);
    expect(completed.event_payload.details).not.toBe('');
  });

  it('emits a failures_count:1 event and re-throws when the scan fails to run', async () => {
    const boom = new Error('Scan timed out after 30000ms');

    const ctx = makeCtx();
    let thrown: unknown;
    await scanAndEmitSecrets(
      SECRETS_CALLER_COMMANDS.gitPreCommit,
      AUTH,
      () => Promise.reject(boom),
      ctx,
    ).catch((err) => {
      thrown = err;
    });
    expect(thrown).toBe(boom);
    await commitTelemetryFacts(ctx.telemetryFacts());

    const lines = readAnalysisEvents(testSonarUserHome);
    expect(lines).toHaveLength(1);
    const completed = lines[0];
    expect(completed.metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
    expect(completed.event_payload.failures_count).toBe(1);
    expect(completed.event_payload.exit_code).toBeNull();
    expect(completed.event_payload.findings_count).toBe(0);
  });

  it('defers NDJSON append when an invocation context is provided', async () => {
    const ctx = makeCtx();
    const result: SpawnResult = { exitCode: 0, stdout: '{}', stderr: '' };
    await scanAndEmitSecrets(
      SECRETS_CALLER_COMMANDS.analyzeSecrets,
      AUTH,
      () => Promise.resolve(result),
      ctx,
    );

    expect(readAnalysisEvents(testSonarUserHome)).toHaveLength(0);
    expect(ctx.telemetryFacts()).toHaveLength(1);
    const pending = ctx.telemetryFacts()[0];
    expect(pending?.name).toBe('CliAnalysisCompleted');
    expect((pending?.payload as { caller_command?: string }).caller_command).toBe(
      SECRETS_CALLER_COMMANDS.analyzeSecrets,
    );
  });
});
