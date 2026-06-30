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
 *   appendFinding                 — NDJSON append, directory creation, fire-and-forget
 *   appendAnalysisCompleted         — CliAnalysisCompleted envelope
 *   appendAnalysisFindingsDetected  — CliAnalysisFindingsDetected envelope
 *   emitSecretsFindings             — telemetry gate, identity resolution, per-issue append
 *   flushFindings                   — atomic rename, retention cap, send, re-queue, concurrent safety
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  AnalysisFindingEventPayload,
  AnalysisFindingsDetectedEventPayload,
  StoredAnalysisCompletedEvent,
  StoredAnalysisEvent,
  StoredAnalysisFindingsDetectedEvent,
  StoredFindingEvent,
} from '../../../src/lib/state.js';
import { getDefaultState } from '../../../src/lib/state.js';
import * as stateManager from '../../../src/lib/state-manager.js';
import {
  appendAnalysisCompleted,
  appendAnalysisFindingsDetected,
  appendFinding,
  emitSecretsFindings,
  flushFindings,
} from '../../../src/telemetry/findings.js';
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

function makePayload(
  overrides: Partial<AnalysisFindingEventPayload> = {},
): AnalysisFindingEventPayload {
  return {
    ...makeIdentityPayload(),
    caller_command: 'git-pre-commit',
    analyzer: 'sonar-secrets',
    rule_key: 'secrets:S6290',
    scan_duration_ms: 123,
    ...overrides,
  };
}

function makeCompletedPayload(
  overrides: Partial<AnalysisCompletedEventPayload> = {},
): AnalysisCompletedEventPayload {
  return {
    ...makeIdentityPayload(),
    caller_command: 'analyze-agentic',
    analyzer: 'sqaa',
    analysis_id: 'analysis-id-123',
    findings_count: 0,
    status: 'clean',
    exit_code: null,
    error_count: 0,
    scan_duration_ms: 456,
    ...overrides,
  };
}

function makeFindingsDetectedPayload(
  overrides: Partial<AnalysisFindingsDetectedEventPayload> = {},
): AnalysisFindingsDetectedEventPayload {
  return {
    ...makeIdentityPayload(),
    caller_command: 'analyze-agentic',
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

// ─── Setup ────────────────────────────────────────────────────────────────────

let testSonarUserHome: string;
const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'cli-findings-test-'));
  process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;
});

afterEach(async () => {
  await rm(testSonarUserHome, { recursive: true, force: true });
  if (previousSonarUserHome === undefined) {
    delete process.env[ENV_SONAR_USER_HOME];
  } else {
    process.env[ENV_SONAR_USER_HOME] = previousSonarUserHome;
  }
});

// ─── appendAnalysisCompleted ───────────────────────────────────────────────────

describe('appendAnalysisCompleted()', () => {
  it('writes a valid CliAnalysisCompleted envelope', () => {
    appendAnalysisCompleted(makeCompletedPayload({ findings_count: 2, status: 'findings' }));

    const [event] = readLines(testSonarUserHome);
    expect(event.metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
    const completedEvent = event as StoredAnalysisCompletedEvent;
    expect(completedEvent.event_payload.analyzer).toBe('sqaa');
    expect(completedEvent.event_payload.findings_count).toBe(2);
    expect(completedEvent.event_payload.status).toBe('findings');
    expect(completedEvent.event_payload.exit_code).toBeNull();
  });
});

// ─── appendAnalysisFindingsDetected ────────────────────────────────────────────

describe('appendAnalysisFindingsDetected()', () => {
  it('writes a valid CliAnalysisFindingsDetected envelope', () => {
    appendAnalysisFindingsDetected(
      makeFindingsDetectedPayload({ analysis_id: 'abc-123', details_schema_version: 1 }),
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
});

// ─── appendFinding ─────────────────────────────────────────────────────────────

describe('appendFinding()', () => {
  it('creates findings.ndjson with one JSON line per call', () => {
    appendFinding(makePayload());

    const lines = readLines(testSonarUserHome);
    expect(lines).toHaveLength(1);
  });

  it('writes a valid StoredFindingEvent envelope', () => {
    appendFinding(makePayload({ rule_key: 'secrets:S1234', scan_duration_ms: 999 }));

    const [event] = readLines(testSonarUserHome);
    expect(event.metadata.event_type).toBe('Analytics.Cli.CliAnalysisFindingDetected');
    const findingEvent = event as StoredFindingEvent;
    expect(findingEvent.metadata.source.domain).toBe('CLI');
    expect(findingEvent.metadata.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof findingEvent.metadata.event_timestamp).toBe('string');
    expect(findingEvent.event_payload.rule_key).toBe('secrets:S1234');
    expect(findingEvent.event_payload.scan_duration_ms).toBe(999);
  });

  it('appends one line per invocation', () => {
    appendFinding(makePayload({ rule_key: 'secrets:A' }));
    appendFinding(makePayload({ rule_key: 'secrets:B' }));
    appendFinding(makePayload({ rule_key: 'secrets:C' }));

    const lines = readLines(testSonarUserHome);
    expect(lines).toHaveLength(3);
    expect(
      lines.map((e) => {
        if (e.metadata.event_type !== 'Analytics.Cli.CliAnalysisFindingDetected') return undefined;
        return (e as StoredFindingEvent).event_payload.rule_key;
      }),
    ).toEqual(['secrets:A', 'secrets:B', 'secrets:C']);
  });

  it('creates the telemetry directory if it does not exist', () => {
    const telemetryDir = join(testSonarUserHome, 'sonarqube-cli', 'telemetry');
    expect(existsSync(telemetryDir)).toBe(false);

    appendFinding(makePayload());

    expect(existsSync(telemetryDir)).toBe(true);
  });

  it('silently swallows errors (e.g. read-only dir)', () => {
    const cliDir = join(testSonarUserHome, 'sonarqube-cli');
    mkdirSync(cliDir, { recursive: true });
    // Create a file where the telemetry dir should be to force an error
    writeFileSync(join(cliDir, 'telemetry'), 'not-a-dir');

    expect(() => appendFinding(makePayload())).not.toThrow();
  });
});

// ─── emitSecretsFindings ───────────────────────────────────────────────────────

describe('emitSecretsFindings()', () => {
  const AUTH: ResolvedAuth = {
    connectionType: 'cloud',
    serverUrl: 'https://sonarcloud.io',
    token: 'test-token',
    orgKey: 'my-org',
  };

  let loadStateSpy: ReturnType<typeof spyOn>;
  let getConnectionSpy: ReturnType<typeof spyOn>;
  let getUserIdSpy: ReturnType<typeof spyOn>;
  let detectAgentSpy: ReturnType<typeof spyOn>;

  let savedDoNotTrack: string | undefined;

  beforeEach(() => {
    // DO_NOT_TRACK may be set in the test environment — clear it so isTelemetryEnabled returns true
    savedDoNotTrack = process.env.DO_NOT_TRACK;
    delete process.env.DO_NOT_TRACK;

    // loadState is re-exported via state-manager — spy on the originating module
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeTelemetryState());
    getConnectionSpy = spyOn(stateManager, 'getActiveConnection').mockReturnValue(undefined);
    getUserIdSpy = spyOn(userModule, 'getOrCreateUserId').mockReturnValue('machine-id');
    detectAgentSpy = spyOn(agentDetector, 'detectCallerAgent').mockReturnValue(null);
  });

  afterEach(() => {
    if (savedDoNotTrack !== undefined) {
      process.env.DO_NOT_TRACK = savedDoNotTrack;
    }
    loadStateSpy.mockRestore();
    getConnectionSpy.mockRestore();
    getUserIdSpy.mockRestore();
    detectAgentSpy.mockRestore();
  });

  it('does not append when issues array is empty', () => {
    emitSecretsFindings('analyze secrets', AUTH, [], 100);

    expect(readLines(testSonarUserHome)).toHaveLength(0);
    expect(loadStateSpy).not.toHaveBeenCalled();
  });

  it('does not append when installationId is absent', () => {
    const stateWithoutId = makeTelemetryState();
    stateWithoutId.telemetry.installationId = undefined;
    loadStateSpy.mockReturnValue(stateWithoutId);

    emitSecretsFindings('analyze secrets', AUTH, [{ ruleKey: 'secrets:S1' }], 100);

    expect(readLines(testSonarUserHome)).toHaveLength(0);
  });

  it('does not append when telemetry is disabled', () => {
    loadStateSpy.mockReturnValue(makeTelemetryState(false));

    emitSecretsFindings('analyze secrets', AUTH, [{ ruleKey: 'secrets:S6290' }], 100);

    expect(readLines(testSonarUserHome)).toHaveLength(0);
  });

  it('appends one finding per issue', () => {
    emitSecretsFindings(
      'analyze secrets',
      AUTH,
      [{ ruleKey: 'secrets:S6290' }, { ruleKey: 'secrets:S6691' }],
      100,
    );

    const lines = readLines(testSonarUserHome);
    expect(lines).toHaveLength(2);
    expect(lines[0].metadata.event_type).toBe('Analytics.Cli.CliAnalysisFindingDetected');
    expect(lines[1].metadata.event_type).toBe('Analytics.Cli.CliAnalysisFindingDetected');
    expect((lines[0] as StoredFindingEvent).event_payload.rule_key).toBe('secrets:S6290');
    expect((lines[1] as StoredFindingEvent).event_payload.rule_key).toBe('secrets:S6691');
  });

  it('sets connection_type to sqc for cloud connections', () => {
    emitSecretsFindings(
      'analyze secrets',
      { ...AUTH, connectionType: 'cloud' },
      [{ ruleKey: 'secrets:S1' }],
      100,
    );

    const [event] = readLines(testSonarUserHome);
    expect(event.metadata.event_type).toBe('Analytics.Cli.CliAnalysisFindingDetected');
    expect((event as StoredFindingEvent).event_payload.connection_type).toBe('sqc');
  });

  it('sets connection_type to sqs for server connections', () => {
    emitSecretsFindings(
      'analyze secrets',
      { ...AUTH, connectionType: 'on-premise' },
      [{ ruleKey: 'secrets:S1' }],
      100,
    );

    const [event] = readLines(testSonarUserHome);
    expect(event.metadata.event_type).toBe('Analytics.Cli.CliAnalysisFindingDetected');
    expect((event as StoredFindingEvent).event_payload.connection_type).toBe('sqs');
  });

  it('records caller_command, analyzer, and scan_duration_ms', () => {
    emitSecretsFindings('git-pre-commit', AUTH, [{ ruleKey: 'secrets:S1' }], 456);

    const [event] = readLines(testSonarUserHome);
    expect(event.metadata.event_type).toBe('Analytics.Cli.CliAnalysisFindingDetected');
    const findingEvent = event as StoredFindingEvent;
    expect(findingEvent.event_payload.caller_command).toBe('git-pre-commit');
    expect(findingEvent.event_payload.analyzer).toBe('sonar-secrets');
    expect(findingEvent.event_payload.scan_duration_ms).toBe(456);
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

  it('POSTs each finding to the telemetry endpoint', async () => {
    appendFinding(makePayload({ rule_key: 'secrets:A' }));
    appendFinding(makePayload({ rule_key: 'secrets:B' }));

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('POSTs CliAnalysisCompleted and CliAnalysisFindingsDetected events', async () => {
    appendAnalysisCompleted(makeCompletedPayload());
    appendAnalysisFindingsDetected(makeFindingsDetectedPayload());

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const types = fetchSpy.mock.calls.map((call: unknown[]) => {
        const body = JSON.parse((call[1] as RequestInit).body as string) as StoredAnalysisEvent;
        return body.metadata.event_type;
      });
      expect(types).toContain('Analytics.Cli.CliAnalysisCompleted');
      expect(types).toContain('Analytics.Cli.CliAnalysisFindingsDetected');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('POSTs a mixed ndjson file with legacy and new event types', async () => {
    appendFinding(makePayload({ rule_key: 'secrets:LEGACY' }));
    appendAnalysisCompleted(makeCompletedPayload({ analysis_id: 'run-1' }));
    appendAnalysisFindingsDetected(makeFindingsDetectedPayload({ analysis_id: 'run-1' }));

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('deletes findings.ndjson after draining', async () => {
    appendFinding(makePayload());

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
      expect(existsSync(findingsPath(testSonarUserHome))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('sends with correct headers and POST method', async () => {
    appendFinding(makePayload());

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

  it('serialises the finding event in the request body', async () => {
    appendFinding(makePayload({ rule_key: 'secrets:S6290', analyzer: 'sonar-secrets' }));

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const parsed = JSON.parse(init.body as string) as StoredFindingEvent;
      expect(parsed.metadata.event_type).toBe('Analytics.Cli.CliAnalysisFindingDetected');
      expect(parsed.event_payload.rule_key).toBe('secrets:S6290');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('omits null values from the serialised body', async () => {
    appendFinding(makePayload({ user_uuid: null }));

    const fetchSpy = mockFetch();
    try {
      await flushFindings(Date.now() + 60_000);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const parsed = JSON.parse(init.body as string) as StoredFindingEvent;
      expect('user_uuid' in parsed.event_payload).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('discards events older than 7 days', async () => {
    const eightDaysAgo = String(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const recentTs = String(Date.now());

    const staleEvent: StoredFindingEvent = {
      metadata: {
        event_id: 'stale-id',
        source: { domain: 'CLI' },
        event_type: 'Analytics.Cli.CliAnalysisFindingDetected',
        event_timestamp: eightDaysAgo,
      },
      event_payload: makePayload({ rule_key: 'secrets:STALE' }),
    };
    const freshEvent: StoredFindingEvent = {
      metadata: {
        event_id: 'fresh-id',
        source: { domain: 'CLI' },
        event_type: 'Analytics.Cli.CliAnalysisFindingDetected',
        event_timestamp: recentTs,
      },
      event_payload: makePayload({ rule_key: 'secrets:FRESH' }),
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
      const parsed = JSON.parse(init.body as string) as StoredFindingEvent;
      expect(parsed.event_payload.rule_key).toBe('secrets:FRESH');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('discards events with a non-numeric event_timestamp', async () => {
    const telemetryDir = join(testSonarUserHome, 'sonarqube-cli', 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    const nanTsEvent: StoredFindingEvent = {
      metadata: {
        event_id: 'nan-id',
        source: { domain: 'CLI' },
        event_type: 'Analytics.Cli.CliAnalysisFindingDetected',
        event_timestamp: 'not-a-number',
      },
      event_payload: makePayload(),
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
    const validEvent: StoredFindingEvent = {
      metadata: {
        event_id: 'ok-id',
        source: { domain: 'CLI' },
        event_type: 'Analytics.Cli.CliAnalysisFindingDetected',
        event_timestamp: String(Date.now()),
      },
      event_payload: makePayload({ rule_key: 'secrets:VALID' }),
    };
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
    appendFinding(makePayload({ rule_key: 'secrets:A' }));
    appendFinding(makePayload({ rule_key: 'secrets:B' }));

    // First event (secrets:A) fails, second (secrets:B) succeeds
    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ ok: true } as Response);

    try {
      await flushFindings(Date.now() + 60_000);
      const requeued = readLines(testSonarUserHome);
      expect(requeued).toHaveLength(1);
      expect(requeued[0].metadata.event_type).toBe('Analytics.Cli.CliAnalysisFindingDetected');
      expect((requeued[0] as StoredFindingEvent).event_payload.rule_key).toBe('secrets:A');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('re-queues all events when the deadline has already passed', async () => {
    appendFinding(makePayload({ rule_key: 'secrets:A' }));
    appendFinding(makePayload({ rule_key: 'secrets:B' }));

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
    appendFinding(makePayload());

    // Remove the file between existsSync and renameSync to simulate a concurrent winner
    const path = findingsPath(testSonarUserHome);
    const { renameSync: realRename } = await import('node:fs');
    let calls = 0;
    const renameSpy = spyOn(await import('node:fs'), 'renameSync').mockImplementation(
      (...args: Parameters<typeof realRename>) => {
        calls++;
        if (calls === 1) {
          realRename(...args); // first call: do the real rename...
          realRename(args[1], path); // ...then rename it back to simulate another process already having taken it
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
    appendFinding(makePayload({ rule_key: 'secrets:A' }));
    appendFinding(makePayload({ rule_key: 'secrets:B' }));

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
