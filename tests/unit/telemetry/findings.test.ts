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
 * Tests for telemetry/findings.ts:
 *   emitAnalysisCompleted         — CliAnalysisCompleted envelope + telemetry gate
 *   emitAnalysisFindingsDetected  — CliAnalysisFindingsDetected envelope + telemetry gate
 *   flushFindings                 — atomic rename, retention cap, send, re-queue, concurrent safety
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import * as agentDetector from '../../../src/lib/agent-detector.js';
import type { ResolvedAuth } from '../../../src/lib/auth-resolver.js';
import { ENV_SONAR_USER_HOME } from '../../../src/lib/config-constants.js';
import * as stateRepository from '../../../src/lib/repository/state-repository.js';
import type { CliState } from '../../../src/lib/state.js';
import type {
  AnalysisCompletedEventPayload,
  AnalysisFindingsDetectedEventPayload,
  StoredAnalysisCompletedEvent,
  StoredAnalysisEvent,
  StoredAnalysisFindingsDetectedEvent,
} from '../../../src/lib/state.js';
import { getDefaultState } from '../../../src/lib/state.js';
import * as stateManager from '../../../src/lib/state-manager.js';
import {
  type AnalysisCompletedFields,
  type AnalysisFindingsDetectedFields,
  emitAnalysisCompleted,
  emitAnalysisFindingsDetected,
  flushFindings,
} from '../../../src/telemetry/findings.js';
import { SQAA_ANALYZE_AGENTIC_CALLER_COMMAND } from '../../../src/telemetry/sqaa-analysis-telemetry.js';
import * as userModule from '../../../src/telemetry/user.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  } as const;
}

function makeCompletedFields(
  overrides: Partial<AnalysisCompletedFields> = {},
): AnalysisCompletedFields {
  return {
    caller_command: SQAA_ANALYZE_AGENTIC_CALLER_COMMAND,
    analyzer: 'sqaa',
    analysis_id: 'analysis-id-123',
    findings_count: 0,
    exit_code: null,
    errors_count: 0,
    failures_count: 0,
    scan_duration_ms: 456,
    ...overrides,
  };
}

function makeCompletedPayload(
  overrides: Partial<AnalysisCompletedEventPayload> = {},
): AnalysisCompletedEventPayload {
  return {
    ...makeIdentityPayload(),
    ...makeCompletedFields(),
    ...overrides,
  };
}

function makeFindingsDetectedFields(
  overrides: Partial<AnalysisFindingsDetectedFields> = {},
): AnalysisFindingsDetectedFields {
  return {
    caller_command: SQAA_ANALYZE_AGENTIC_CALLER_COMMAND,
    analyzer: 'sqaa',
    analysis_id: 'analysis-id-123',
    details_schema_version: 1,
    details: JSON.stringify({
      rule_keys: ['sqaa:S1234'],
      counts_by_rule: { 'sqaa:S1234': 1 },
    }),
    ...overrides,
  };
}

function makeFindingsDetectedPayload(
  overrides: Partial<AnalysisFindingsDetectedEventPayload> = {},
): AnalysisFindingsDetectedEventPayload {
  return {
    ...makeIdentityPayload(),
    ...makeFindingsDetectedFields(),
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

function makeStoredFindingsDetectedEvent(
  overrides: Partial<AnalysisFindingsDetectedEventPayload> = {},
): StoredAnalysisFindingsDetectedEvent {
  return {
    metadata: {
      event_id: 'findings-id',
      source: { domain: 'CLI' },
      event_type: 'Analytics.Cli.CliAnalysisFindingsDetected',
      event_timestamp: String(Date.now()),
    },
    event_payload: makeFindingsDetectedPayload(overrides),
  };
}

function findingsPath(sonarUserHome: string): string {
  return join(sonarUserHome, 'sonarqube-cli', 'telemetry', 'findings.ndjson');
}

function readLines(sonarUserHome: string): StoredAnalysisEvent[] {
  const path = findingsPath(sonarUserHome);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredAnalysisEvent);
}

function writeStoredEvent(event: StoredAnalysisEvent): void {
  const telemetryDir = join(testSonarUserHome, 'sonarqube-cli', 'telemetry');
  mkdirSync(telemetryDir, { recursive: true });
  appendFileSync(findingsPath(testSonarUserHome), JSON.stringify(event) + '\n');
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

function makeTelemetryState(enabled = true): CliState {
  const state = getDefaultState('1.0.0');
  state.telemetry.enabled = enabled;
  state.telemetry.installationId = 'install-id';
  return state;
}

const AUTH: ResolvedAuth = {
  connectionType: 'cloud',
  serverUrl: 'https://sonarcloud.io',
  token: 'test-token',
  orgKey: 'my-org',
};

// ─── Setup ────────────────────────────────────────────────────────────────────

let testSonarUserHome: string;
const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];

let loadStateSpy: ReturnType<typeof spyOn>;
let getConnectionSpy: ReturnType<typeof spyOn>;
let getUserIdSpy: ReturnType<typeof spyOn>;
let detectAgentSpy: ReturnType<typeof spyOn>;
let savedDoNotTrack: string | undefined;

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'cli-findings-test-'));
  process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;

  savedDoNotTrack = process.env.DO_NOT_TRACK;
  delete process.env.DO_NOT_TRACK;

  loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeTelemetryState());
  getConnectionSpy = spyOn(stateManager, 'getActiveConnection').mockReturnValue(undefined);
  getUserIdSpy = spyOn(userModule, 'getOrCreateUserId').mockReturnValue('machine-id');
  detectAgentSpy = spyOn(agentDetector, 'detectCallerAgent').mockReturnValue(null);
});

afterEach(async () => {
  if (savedDoNotTrack !== undefined) {
    process.env.DO_NOT_TRACK = savedDoNotTrack;
  } else {
    delete process.env.DO_NOT_TRACK;
  }

  loadStateSpy.mockRestore();
  getConnectionSpy.mockRestore();
  getUserIdSpy.mockRestore();
  detectAgentSpy.mockRestore();

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
    await emitAnalysisCompleted(AUTH, makeCompletedFields({ findings_count: 2, exit_code: 51 }));

    const [event] = readLines(testSonarUserHome);
    expect(event.metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
    const completedEvent = event as StoredAnalysisCompletedEvent;
    expect(completedEvent.event_payload.analyzer).toBe('sqaa');
    expect(completedEvent.event_payload.findings_count).toBe(2);
    expect(completedEvent.event_payload.exit_code).toBe(51);
    expect(completedEvent.event_payload.caller_command).toBe(SQAA_ANALYZE_AGENTIC_CALLER_COMMAND);
  });

  it('does not append when telemetry is disabled', async () => {
    loadStateSpy.mockReturnValue(makeTelemetryState(false));

    await emitAnalysisCompleted(AUTH, makeCompletedFields());

    expect(readLines(testSonarUserHome)).toHaveLength(0);
  });

  it('does not append when installationId is absent', async () => {
    const stateWithoutId = makeTelemetryState();
    stateWithoutId.telemetry.installationId = undefined;
    loadStateSpy.mockReturnValue(stateWithoutId);

    await emitAnalysisCompleted(AUTH, makeCompletedFields());

    expect(readLines(testSonarUserHome)).toHaveLength(0);
  });

  it('sets connection_type to sqc for cloud connections', async () => {
    await emitAnalysisCompleted({ ...AUTH, connectionType: 'cloud' }, makeCompletedFields());

    const [event] = readLines(testSonarUserHome);
    expect((event as StoredAnalysisCompletedEvent).event_payload.connection_type).toBe('sqc');
  });

  it('sets connection_type to sqs for server connections', async () => {
    await emitAnalysisCompleted({ ...AUTH, connectionType: 'on-premise' }, makeCompletedFields());

    const [event] = readLines(testSonarUserHome);
    expect((event as StoredAnalysisCompletedEvent).event_payload.connection_type).toBe('sqs');
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

    await emitAnalysisCompleted(AUTH, makeCompletedFields());

    const payload = (readLines(testSonarUserHome)[0] as StoredAnalysisCompletedEvent).event_payload;
    expect(payload.user_uuid).toBe('user-uuid-abc');
    expect(payload.organization_uuid_v4).toBe('org-uuid-xyz');
    expect(payload.sqs_installation_id).toBe('sqs-install-id-123');
  });

  it('sets caller_agent from detectCallerAgent', async () => {
    detectAgentSpy.mockReturnValue('cursor');

    await emitAnalysisCompleted(AUTH, makeCompletedFields());

    const payload = (readLines(testSonarUserHome)[0] as StoredAnalysisCompletedEvent).event_payload;
    expect(payload.caller_agent).toBe('cursor');
  });

  it('creates the telemetry directory if it does not exist', async () => {
    const telemetryDir = join(testSonarUserHome, 'sonarqube-cli', 'telemetry');
    expect(existsSync(telemetryDir)).toBe(false);

    await emitAnalysisCompleted(AUTH, makeCompletedFields());

    expect(existsSync(telemetryDir)).toBe(true);
  });
});

// ─── emitAnalysisFindingsDetected ──────────────────────────────────────────────

describe('emitAnalysisFindingsDetected()', () => {
  it('writes a valid CliAnalysisFindingsDetected envelope', async () => {
    await emitAnalysisFindingsDetected(
      AUTH,
      makeFindingsDetectedFields({ analysis_id: 'abc-123', details_schema_version: 1 }),
    );

    const [event] = readLines(testSonarUserHome);
    expect(event.metadata.event_type).toBe('Analytics.Cli.CliAnalysisFindingsDetected');
    const findingsEvent = event as StoredAnalysisFindingsDetectedEvent;
    expect(findingsEvent.event_payload.analysis_id).toBe('abc-123');
    expect(findingsEvent.event_payload.details_schema_version).toBe(1);
    expect(JSON.parse(findingsEvent.event_payload.details)).toEqual({
      rule_keys: ['sqaa:S1234'],
      counts_by_rule: { 'sqaa:S1234': 1 },
    });
  });

  it('does not append when telemetry is disabled', async () => {
    loadStateSpy.mockReturnValue(makeTelemetryState(false));

    await emitAnalysisFindingsDetected(AUTH, makeFindingsDetectedFields());

    expect(readLines(testSonarUserHome)).toHaveLength(0);
  });
});

// ─── flushFindings ─────────────────────────────────────────────────────────────

describe('flushFindings()', () => {
  it('does nothing when findings.ndjson does not exist', async () => {
    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('POSTs each event to the telemetry endpoint', async () => {
    writeStoredEvent(makeStoredCompletedEvent({ analysis_id: 'run-a' }));
    writeStoredEvent(makeStoredCompletedEvent({ analysis_id: 'run-b' }));

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('POSTs CliAnalysisCompleted and CliAnalysisFindingsDetected events from the same ndjson file', async () => {
    writeStoredEvent(makeStoredCompletedEvent({ analysis_id: 'run-1' }));
    writeStoredEvent(makeStoredFindingsDetectedEvent({ analysis_id: 'run-1' }));

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const types = fetchSpy.mock.calls.map((call: unknown[]) => {
        const body = JSON.parse((call[1] as RequestInit).body as string) as StoredAnalysisEvent;
        expect(body.event_payload.analysis_id).toBe('run-1');
        return body.metadata.event_type;
      });
      expect(types).toContain('Analytics.Cli.CliAnalysisCompleted');
      expect(types).toContain('Analytics.Cli.CliAnalysisFindingsDetected');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('deletes findings.ndjson after draining', async () => {
    writeStoredEvent(makeStoredCompletedEvent());

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
      expect(existsSync(findingsPath(testSonarUserHome))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('sends with correct headers and POST method', async () => {
    writeStoredEvent(makeStoredCompletedEvent());

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect((init.headers as Record<string, string>)['x-api-key']).toBeTruthy();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('serialises the analysis event in the request body', async () => {
    writeStoredEvent(makeStoredCompletedEvent({ findings_count: 3, exit_code: 51 }));

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const parsed = JSON.parse(init.body as string) as StoredAnalysisCompletedEvent;
      expect(parsed.metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
      expect(parsed.event_payload.findings_count).toBe(3);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('omits null values from the serialised body', async () => {
    writeStoredEvent(makeStoredCompletedEvent());

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
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
      findingsPath(testSonarUserHome),
      [JSON.stringify(staleEvent), JSON.stringify(freshEvent)].join('\n') + '\n',
    );

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
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
    writeFileSync(findingsPath(testSonarUserHome), JSON.stringify(nanTsEvent) + '\n');

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
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
      findingsPath(testSonarUserHome),
      ['not-valid-json', JSON.stringify(validEvent), '{broken'].join('\n') + '\n',
    );

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('re-queues events that fail to send for the next flush', async () => {
    writeStoredEvent(makeStoredCompletedEvent({ analysis_id: 'run-a' }));
    writeStoredEvent(makeStoredCompletedEvent({ analysis_id: 'run-b' }));

    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ ok: true } as Response);

    try {
      await flushFindings(Date.now() + 60_000);
      const requeued = readLines(testSonarUserHome);
      expect(requeued).toHaveLength(1);
      expect(requeued[0].metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
      expect((requeued[0] as StoredAnalysisCompletedEvent).event_payload.analysis_id).toBe('run-a');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('re-queues all events when the deadline has already passed', async () => {
    writeStoredEvent(makeStoredCompletedEvent({ analysis_id: 'run-a' }));
    writeStoredEvent(makeStoredCompletedEvent({ analysis_id: 'run-b' }));

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() - 1);
      expect(fetchSpy).not.toHaveBeenCalled();
      const requeued = readLines(testSonarUserHome);
      expect(requeued).toHaveLength(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('is a no-op when a concurrent flush already renamed the file (ENOENT race)', async () => {
    writeStoredEvent(makeStoredCompletedEvent());

    const path = findingsPath(testSonarUserHome);
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
      await flushFindings(Date.now() + 60_000);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('silently swallows individual send failures', async () => {
    writeStoredEvent(makeStoredCompletedEvent({ analysis_id: 'run-a' }));
    writeStoredEvent(makeStoredCompletedEvent({ analysis_id: 'run-b' }));

    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ ok: true } as Response);

    try {
      let threw = false;
      try {
        await flushFindings(Date.now() + 60_000);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
