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

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { RunTally } from '../../../src/cli/commands/analyze/sqaa-analysis.js';
import type { SqaaJsonReport } from '../../../src/cli/commands/analyze/sqaa-display-json.js';
import type { ResolvedAuth } from '../../../src/lib/auth-resolver.js';
import { ENV_SONAR_USER_HOME } from '../../../src/lib/config-constants.js';
import * as stateRepository from '../../../src/lib/repository/state-repository.js';
import type {
  StoredAnalysisCompletedEvent,
  StoredAnalysisEvent,
  StoredAnalysisFindingsDetectedEvent,
} from '../../../src/lib/state.js';
import { getDefaultState } from '../../../src/lib/state.js';
import * as stateManager from '../../../src/lib/state-manager.js';
import type { SqaaIssue } from '../../../src/sonarqube/client.js';
import {
  collectRuleCounts,
  emitSqaaAnalysisTelemetry,
  SQAA_ANALYZE_AGENTIC_CALLER_COMMAND,
  SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
  SQAA_DETAILS_SCHEMA_VERSION,
  tallyFromSqaaJsonReport,
} from '../../../src/telemetry/sqaa-analysis-telemetry.js';
import * as userModule from '../../../src/telemetry/user.js';

const AUTH: ResolvedAuth = {
  connectionType: 'cloud',
  serverUrl: 'https://sonarcloud.io',
  token: 'test-token',
  orgKey: 'my-org',
};

function makeIssue(rule: string, message = 'issue'): SqaaIssue {
  return {
    id: `id-${rule}-${message}`,
    message,
    rule,
  };
}

function makeTally(overrides: Partial<RunTally> = {}): RunTally {
  return {
    allResults: [],
    totalIssues: 0,
    totalErrors: 0,
    totalFailures: 0,
    ...overrides,
  };
}

function findingsPath(sonarUserHome: string): string {
  return join(sonarUserHome, 'sonarqube-cli', 'telemetry', 'findings.ndjson');
}

function readEvents(sonarUserHome: string): StoredAnalysisEvent[] {
  const path = findingsPath(sonarUserHome);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredAnalysisEvent);
}

function makeTelemetryState(enabled = true) {
  const state = getDefaultState('1.0.0');
  state.telemetry.enabled = enabled;
  state.telemetry.installationId = 'install-id';
  return state;
}

let testSonarUserHome: string;
const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];
let loadStateSpy: ReturnType<typeof spyOn>;
let getConnectionSpy: ReturnType<typeof spyOn>;
let getUserIdSpy: ReturnType<typeof spyOn>;
let savedDoNotTrack: string | undefined;

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'cli-sqaa-telemetry-test-'));
  process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;

  savedDoNotTrack = process.env.DO_NOT_TRACK;
  delete process.env.DO_NOT_TRACK;

  loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeTelemetryState());
  getConnectionSpy = spyOn(stateManager, 'getActiveConnection').mockReturnValue(undefined);
  getUserIdSpy = spyOn(userModule, 'getOrCreateUserId').mockReturnValue('machine-id');
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

  await rm(testSonarUserHome, { recursive: true, force: true });
  if (previousSonarUserHome === undefined) {
    delete process.env[ENV_SONAR_USER_HOME];
  } else {
    process.env[ENV_SONAR_USER_HOME] = previousSonarUserHome;
  }
});

describe('collectRuleCounts()', () => {
  it('aggregates counts by rule key', () => {
    expect(
      collectRuleCounts([
        makeIssue('sqaa:S1234', 'a'),
        makeIssue('sqaa:S1234', 'b'),
        makeIssue('sqaa:S5678'),
      ]),
    ).toEqual({
      rule_keys: ['sqaa:S1234', 'sqaa:S5678'],
      counts_by_rule: { 'sqaa:S1234': 2, 'sqaa:S5678': 1 },
    });
  });
});

describe('tallyFromSqaaJsonReport()', () => {
  it('builds a RunTally from a JSON report', () => {
    const report: SqaaJsonReport = {
      files: [
        {
          path: 'src/a.ts',
          issues: [makeIssue('sqaa:S1234', 'a'), makeIssue('sqaa:S1234', 'b')],
          errors: [{ code: 'E1', message: 'warn' }],
        },
      ],
      ignored: [],
      failures: [{ path: 'src/b.ts', message: 'HTTP 500' }],
      skipped: [],
      summary: { totalIssues: 2, totalFailures: 1, totalSkipped: 0 },
      analysisDepth: 'STANDARD',
    };

    const tally = tallyFromSqaaJsonReport(report);
    expect(tally.totalIssues).toBe(2);
    expect(tally.totalErrors).toBe(1);
    expect(tally.totalFailures).toBe(1);
    expect(tally.allResults).toHaveLength(2);
  });
});

describe('emitSqaaAnalysisTelemetry()', () => {
  it('writes CliAnalysisCompleted only on a clean run', async () => {
    await emitSqaaAnalysisTelemetry(SQAA_ANALYZE_AGENTIC_CALLER_COMMAND, AUTH, makeTally(), 123, 0);

    const events = readEvents(testSonarUserHome);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
    const completed = events[0] as StoredAnalysisCompletedEvent;
    expect(completed.event_payload.caller_command).toBe(SQAA_ANALYZE_AGENTIC_CALLER_COMMAND);
    expect(completed.event_payload.analyzer).toBe('sqaa');
    expect(completed.event_payload.findings_count).toBe(0);
    expect(completed.event_payload.exit_code).toBe(0);
    expect(completed.event_payload.errors_count).toBe(0);
    expect(completed.event_payload.failures_count).toBe(0);
    expect(completed.event_payload.scan_duration_ms).toBe(123);
    expect(completed.event_payload.analysis_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('emits null exit_code when the handler does not pass one', async () => {
    await emitSqaaAnalysisTelemetry(
      SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
      AUTH,
      makeTally(),
      123,
    );

    const completed = readEvents(testSonarUserHome)[0] as StoredAnalysisCompletedEvent;
    expect(completed.event_payload.exit_code).toBeNull();
    expect(completed.event_payload.failures_count).toBe(0);
  });

  it('emits failures_count when files fail even without exit_code', async () => {
    const tally = makeTally({
      totalFailures: 1,
      allResults: [
        {
          file: 'src/a.ts',
          filePath: 'src/a.ts',
          failure: new Error('HTTP 500'),
        },
      ],
    });

    await emitSqaaAnalysisTelemetry(SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND, AUTH, tally, 123);

    const completed = readEvents(testSonarUserHome)[0] as StoredAnalysisCompletedEvent;
    expect(completed.event_payload.exit_code).toBeNull();
    expect(completed.event_payload.failures_count).toBe(1);
  });

  it('writes Completed and FindingsDetected with matching analysis_id when issues exist', async () => {
    const tally = makeTally({
      totalIssues: 2,
      allResults: [
        {
          file: 'src/a.ts',
          filePath: 'src/a.ts',
          issues: [makeIssue('sqaa:S1234', 'a'), makeIssue('sqaa:S1234', 'b')],
          errors: null,
        },
      ],
    });

    await emitSqaaAnalysisTelemetry(SQAA_ANALYZE_AGENTIC_CALLER_COMMAND, AUTH, tally, 456, 51);

    const events = readEvents(testSonarUserHome);
    expect(events).toHaveLength(2);
    const completed = events.find(
      (e) => e.metadata.event_type === 'Analytics.Cli.CliAnalysisCompleted',
    ) as StoredAnalysisCompletedEvent | undefined;
    const findings = events.find(
      (e) => e.metadata.event_type === 'Analytics.Cli.CliAnalysisFindingsDetected',
    ) as StoredAnalysisFindingsDetectedEvent | undefined;
    expect(completed).toBeDefined();
    expect(findings).toBeDefined();
    expect(completed!.event_payload.analysis_id).toBe(findings!.event_payload.analysis_id);
    expect(completed!.event_payload.findings_count).toBe(2);
    expect(completed!.event_payload.exit_code).toBe(51);
    expect(findings!.event_payload.details_schema_version).toBe(SQAA_DETAILS_SCHEMA_VERSION);
    expect(JSON.parse(findings!.event_payload.details)).toEqual({
      rule_keys: ['sqaa:S1234'],
      counts_by_rule: { 'sqaa:S1234': 2 },
    });
  });

  it('writes exit code 1 when failures exist without issues', async () => {
    const tally = makeTally({
      totalFailures: 1,
      allResults: [
        {
          file: 'src/a.ts',
          filePath: 'src/a.ts',
          failure: new Error('HTTP 500'),
        },
      ],
    });

    await emitSqaaAnalysisTelemetry(SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND, AUTH, tally, 789, 1);

    const events = readEvents(testSonarUserHome);
    expect(events).toHaveLength(1);
    const completed = events[0] as StoredAnalysisCompletedEvent;
    expect(completed.event_payload.caller_command).toBe(SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND);
    expect(completed.event_payload.exit_code).toBe(1);
    expect(completed.event_payload.errors_count).toBe(0);
    expect(completed.event_payload.failures_count).toBe(1);
    expect(completed.event_payload.findings_count).toBe(0);
  });

  it('counts API errors from successful analyses in errors_count', async () => {
    const tally = makeTally({
      totalIssues: 1,
      totalErrors: 2,
      allResults: [
        {
          file: 'src/a.ts',
          filePath: 'src/a.ts',
          issues: [makeIssue('sqaa:S1234')],
          errors: [
            { code: 'E1', message: 'warn 1' },
            { code: 'E2', message: 'warn 2' },
          ],
        },
      ],
    });

    await emitSqaaAnalysisTelemetry(SQAA_ANALYZE_AGENTIC_CALLER_COMMAND, AUTH, tally, 100, 51);

    const completed = readEvents(testSonarUserHome)[0] as StoredAnalysisCompletedEvent;
    expect(completed.event_payload.exit_code).toBe(51);
    expect(completed.event_payload.errors_count).toBe(2);
  });

  it('uses exit code 1 when failures coexist with findings', async () => {
    const tally = makeTally({
      totalIssues: 2,
      totalFailures: 1,
      allResults: [
        {
          file: 'src/a.ts',
          filePath: 'src/a.ts',
          issues: [makeIssue('sqaa:S1234', 'a'), makeIssue('sqaa:S1234', 'b')],
          errors: null,
        },
        {
          file: 'src/b.ts',
          filePath: 'src/b.ts',
          failure: new Error('HTTP 500'),
        },
      ],
    });

    await emitSqaaAnalysisTelemetry(SQAA_ANALYZE_AGENTIC_CALLER_COMMAND, AUTH, tally, 100, 1);

    const events = readEvents(testSonarUserHome);
    expect(events).toHaveLength(2);
    const completed = events[0] as StoredAnalysisCompletedEvent;
    expect(completed.event_payload.exit_code).toBe(1);
    expect(completed.event_payload.findings_count).toBe(2);
    expect(completed.event_payload.errors_count).toBe(0);
    expect(completed.event_payload.failures_count).toBe(1);
  });

  it('does not write when telemetry is disabled', async () => {
    loadStateSpy.mockReturnValue(makeTelemetryState(false));

    await emitSqaaAnalysisTelemetry(
      SQAA_ANALYZE_AGENTIC_CALLER_COMMAND,
      AUTH,
      makeTally({ totalIssues: 1, allResults: [] }),
      100,
    );

    expect(readEvents(testSonarUserHome)).toHaveLength(0);
  });

  it('does not write when installationId is absent', async () => {
    const stateWithoutId = makeTelemetryState();
    stateWithoutId.telemetry.installationId = undefined;
    loadStateSpy.mockReturnValue(stateWithoutId);

    await emitSqaaAnalysisTelemetry(SQAA_ANALYZE_AGENTIC_CALLER_COMMAND, AUTH, makeTally(), 100);

    expect(readEvents(testSonarUserHome)).toHaveLength(0);
  });
});
