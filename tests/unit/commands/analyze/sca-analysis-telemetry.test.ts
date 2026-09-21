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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type {
  AnalysisErrorResource,
  AnalyzeProjectIssue,
  AnalyzeProjectRelease,
  AnalyzeProjectResponse,
  ScaIssueType,
  Severity,
} from '@/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import {
  recordScaAnalysisTelemetry,
  SCA_CALLER_COMMANDS,
  type ScaCallerCommand,
  summarizeScaFindings,
} from '@/commands/analyze/sca-analysis-telemetry.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandInvocationContext, type StatsFact } from '@/core/commands/invocation-context.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import * as stateManager from '@/core/state/state-manager.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import { type AnalyzerStatsFactPayload, commitStatsFacts } from '@/core/stats/facts.ts';
import { commitTelemetryFacts } from '@/core/telemetry';
import * as userModule from '@/core/telemetry/user.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';
import { readStatsEvents } from '../../../_common/stats-helpers.ts';
import { makeTelemetryState, readAnalysisEvents } from '../../../_common/telemetry-helpers.ts';

const AUTH = new ResolvedAuth({
  connectionType: 'cloud',
  source: 'state' as const,
  serverUrl: 'https://sonarcloud.io',
  token: 'test-token',
  orgKey: 'my-org',
});

function emitScaAnalysisStats(
  callerCommand: ScaCallerCommand,
  response: AnalyzeProjectResponse | null,
  durationMs: number,
  exitCode: number | null,
): readonly StatsFact[] {
  const ctx = new CommandInvocationContext(new FakeConsole());
  recordScaAnalysisTelemetry(ctx, AUTH, callerCommand, response, durationMs, exitCode);
  return ctx.statsFacts();
}

async function emitScaAnalysisTelemetry(
  callerCommand: ScaCallerCommand,
  _auth: ResolvedAuth,
  response: AnalyzeProjectResponse | null,
  durationMs: number,
  exitCode: number | null,
): Promise<void> {
  const ctx = new CommandInvocationContext(new FakeConsole());
  recordScaAnalysisTelemetry(ctx, AUTH, callerCommand, response, durationMs, exitCode);
  await commitTelemetryFacts(ctx.telemetryFacts());
}

function makeIssue(type: ScaIssueType, severity: Severity): AnalyzeProjectIssue {
  return {
    key: `issue-${type}-${severity}`,
    severity,
    showIncreasedSeverityWarning: null,
    type,
    quality: 'SECURITY',
    status: null,
    vulnerabilityId: null,
    cweIds: null,
    cvssScore: null,
    spdxLicenseId: null,
    versionOptions: null,
  };
}

function makeRelease(
  newlyIntroduced: boolean,
  issues: AnalyzeProjectIssue[],
): AnalyzeProjectRelease {
  return {
    key: 'pkg@1.0.0',
    packageUrl: 'pkg:npm/pkg@1.0.0',
    packageManager: 'npm',
    packageName: 'pkg',
    version: '1.0.0',
    licenseExpression: null,
    known: true,
    knownPackage: true,
    newlyIntroduced,
    issues,
    dependencyFilePaths: [],
    dependencyChains: [],
  };
}

function makeResponse(
  releases: AnalyzeProjectRelease[],
  errors: AnalysisErrorResource[] = [],
): AnalyzeProjectResponse {
  return { releases, parsedFiles: [], errors };
}

function makeError(
  code: AnalysisErrorResource['code'] = 'NO_DEPENDENCIES_FOUND',
): AnalysisErrorResource {
  return { id: `err-${code}`, code, path: null, message: 'error' };
}

const IS_WINDOWS = process.platform === 'win32';

let testSonarUserHome: string;
const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];
let loadStateSpy: ReturnType<typeof spyOn>;
let getConnectionSpy: ReturnType<typeof spyOn>;
let getUserIdSpy: ReturnType<typeof spyOn>;
let savedDoNotTrack: string | undefined;

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'cli-sca-telemetry-test-'));
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

  // Windows can hold the just-closed stats db's WAL/SHM handles past our retries;
  // best-effort only — the OS reclaims the temp dir regardless.
  await rm(testSonarUserHome, {
    recursive: true,
    force: true,
    maxRetries: IS_WINDOWS ? 15 : 5,
    retryDelay: IS_WINDOWS ? 200 : 100,
  }).catch(() => {});
  if (previousSonarUserHome === undefined) {
    delete process.env[ENV_SONAR_USER_HOME];
  } else {
    process.env[ENV_SONAR_USER_HOME] = previousSonarUserHome;
  }
});

describe('summarizeScaFindings()', () => {
  it('counts only issues on newly-introduced releases, keyed by <type>:<severity>', () => {
    const response = makeResponse([
      makeRelease(true, [
        makeIssue('VULNERABILITY', 'HIGH'),
        makeIssue('VULNERABILITY', 'HIGH'),
        makeIssue('MALWARE', 'BLOCKER'),
      ]),
      // Pre-existing release — excluded from both count and details.
      makeRelease(false, [makeIssue('VULNERABILITY', 'LOW')]),
    ]);

    expect(summarizeScaFindings(response)).toEqual({
      findingsCount: 3,
      details: { counts_by_rule: { 'VULNERABILITY:HIGH': 2, 'MALWARE:BLOCKER': 1 } },
    });
  });

  it('maps PROHIBITED_LICENSE as a raw-enum key', () => {
    const response = makeResponse([makeRelease(true, [makeIssue('PROHIBITED_LICENSE', 'MEDIUM')])]);

    expect(summarizeScaFindings(response).details.counts_by_rule).toEqual({
      'PROHIBITED_LICENSE:MEDIUM': 1,
    });
  });

  it('returns zero for an empty response', () => {
    expect(summarizeScaFindings(makeResponse([]))).toEqual({
      findingsCount: 0,
      details: { counts_by_rule: {} },
    });
  });

  it('returns zero when only pre-existing releases carry issues', () => {
    const response = makeResponse([makeRelease(false, [makeIssue('VULNERABILITY', 'HIGH')])]);

    expect(summarizeScaFindings(response)).toEqual({
      findingsCount: 0,
      details: { counts_by_rule: {} },
    });
  });

  it('ignores a newly-introduced release with no issues', () => {
    const response = makeResponse([makeRelease(true, [])]);

    expect(summarizeScaFindings(response).findingsCount).toBe(0);
  });
});

describe('recordScaAnalysisTelemetry()', () => {
  it('writes a single CliAnalysisCompleted with details "" on a clean run (no new findings)', async () => {
    const response = makeResponse([makeRelease(false, [makeIssue('VULNERABILITY', 'HIGH')])]);

    await emitScaAnalysisTelemetry(
      SCA_CALLER_COMMANDS.analyzeDependencyRisks,
      AUTH,
      response,
      123,
      0,
    );

    const events = readAnalysisEvents(testSonarUserHome);
    expect(events).toHaveLength(1);
    const completed = events[0];
    expect(completed.metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
    expect(completed.event_payload.caller_command).toBe('analyze dependency-risks');
    expect(completed.event_payload.analyzer).toBe('sca-scanner-cli');
    expect(completed.event_payload.findings_count).toBe(0);
    expect(completed.event_payload.exit_code).toBe(0);
    expect(completed.event_payload.errors_count).toBe(0);
    expect(completed.event_payload.failures_count).toBe(0);
    expect(completed.event_payload.scan_duration_ms).toBe(123);
    expect(completed.event_payload.details).toBe('');
    expect(completed.event_payload.analysis_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes a single CliAnalysisCompleted with populated details when new findings exist', async () => {
    const response = makeResponse(
      [makeRelease(true, [makeIssue('VULNERABILITY', 'HIGH'), makeIssue('VULNERABILITY', 'HIGH')])],
      [makeError()],
    );

    await emitScaAnalysisTelemetry(
      SCA_CALLER_COMMANDS.analyzeDependencyRisks,
      AUTH,
      response,
      456,
      51,
    );

    const events = readAnalysisEvents(testSonarUserHome);
    expect(events).toHaveLength(1);
    const completed = events[0];
    expect(completed.metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
    expect(completed.event_payload.findings_count).toBe(2);
    expect(completed.event_payload.exit_code).toBe(51);
    expect(completed.event_payload.errors_count).toBe(1);
    expect(completed.event_payload.failures_count).toBe(0);
    expect(completed.event_payload.analyzer).toBe('sca-scanner-cli');
    expect(JSON.parse(completed.event_payload.details)).toEqual({
      counts_by_rule: { 'VULNERABILITY:HIGH': 2 },
    });
  });

  it('records a failed-to-run scan (response null) as failures_count 1 with details ""', async () => {
    await emitScaAnalysisTelemetry(SCA_CALLER_COMMANDS.gitPreCommit, AUTH, null, 77, null);

    const events = readAnalysisEvents(testSonarUserHome);
    expect(events).toHaveLength(1);
    const completed = events[0];
    expect(completed.event_payload.caller_command).toBe('git-pre-commit');
    expect(completed.event_payload.analyzer).toBe('sca-scanner-cli');
    expect(completed.event_payload.findings_count).toBe(0);
    expect(completed.event_payload.exit_code).toBeNull();
    expect(completed.event_payload.errors_count).toBe(0);
    expect(completed.event_payload.failures_count).toBe(1);
    expect(completed.event_payload.scan_duration_ms).toBe(77);
    expect(completed.event_payload.details).toBe('');
  });

  it('populates details for the git-pre-commit caller too', async () => {
    const response = makeResponse([makeRelease(true, [makeIssue('MALWARE', 'BLOCKER')])]);

    await emitScaAnalysisTelemetry(SCA_CALLER_COMMANDS.gitPreCommit, AUTH, response, 10, null);

    const events = readAnalysisEvents(testSonarUserHome);
    expect(events).toHaveLength(1);
    const completed = events[0];
    expect(completed.metadata.event_type).toBe('Analytics.Cli.CliAnalysisCompleted');
    expect(completed.event_payload.caller_command).toBe('git-pre-commit');
    expect(JSON.parse(completed.event_payload.details)).toEqual({
      counts_by_rule: { 'MALWARE:BLOCKER': 1 },
    });
  });

  it('does not write when telemetry is disabled', async () => {
    loadStateSpy.mockReturnValue(makeTelemetryState(false));

    await emitScaAnalysisTelemetry(
      SCA_CALLER_COMMANDS.analyzeDependencyRisks,
      AUTH,
      makeResponse([makeRelease(true, [makeIssue('VULNERABILITY', 'HIGH')])]),
      100,
      51,
    );

    expect(readAnalysisEvents(testSonarUserHome)).toHaveLength(0);
  });

  it('does not write when installationId is absent', async () => {
    const stateWithoutId = makeTelemetryState();
    stateWithoutId.telemetry.installationId = undefined;
    loadStateSpy.mockReturnValue(stateWithoutId);

    await emitScaAnalysisTelemetry(
      SCA_CALLER_COMMANDS.analyzeDependencyRisks,
      AUTH,
      null,
      100,
      null,
    );

    expect(readAnalysisEvents(testSonarUserHome)).toHaveLength(0);
  });

  it('never throws when identity resolution fails (strictly fire-and-forget)', async () => {
    // getOrCreateUserId does mkdirSync/openSync and can throw on permission/disk errors.
    getUserIdSpy.mockImplementation(() => {
      throw new Error('disk full');
    });
    const response = makeResponse([makeRelease(true, [makeIssue('VULNERABILITY', 'HIGH')])]);

    // Must resolve, not reject — a telemetry failure must never reach the command handler.
    await emitScaAnalysisTelemetry(
      SCA_CALLER_COMMANDS.analyzeDependencyRisks,
      AUTH,
      response,
      100,
      51,
    );

    expect(readAnalysisEvents(testSonarUserHome)).toHaveLength(0);
  });
});

describe('recordScaAnalysisTelemetry(): stats', () => {
  it('records findingsCount 0 and no ruleCounts for a clean run', () => {
    const response = makeResponse([makeRelease(false, [makeIssue('VULNERABILITY', 'HIGH')])]);

    const facts = emitScaAnalysisStats(
      SCA_CALLER_COMMANDS.analyzeDependencyRisks,
      response,
      123,
      0,
    );
    commitStatsFacts(facts);

    const [event] = readStatsEvents(testSonarUserHome);
    expect(event.caller_command).toBe('analyze dependency-risks');
    expect(event.exit_code).toBe(0);
    expect(event.run_trigger).toBe('manual');
    expect(event.parsedDetails.analyzer).toBe('sca-scanner-cli');
    expect(event.parsedDetails.findingsCount).toBe(0);
    expect(event.parsedDetails.ruleCounts).toBeUndefined();
  });

  it('records raw (non-deduped) findingsCount and ruleCounts when new findings exist', () => {
    const response = makeResponse([
      makeRelease(true, [makeIssue('VULNERABILITY', 'HIGH'), makeIssue('VULNERABILITY', 'HIGH')]),
    ]);

    const facts = emitScaAnalysisStats(
      SCA_CALLER_COMMANDS.analyzeDependencyRisks,
      response,
      456,
      51,
    );
    commitStatsFacts(facts);

    const [event] = readStatsEvents(testSonarUserHome);
    expect(event.parsedDetails.findingsCount).toBe(2);
    expect(event.parsedDetails.ruleCounts).toEqual({ 'VULNERABILITY:HIGH': 2 });
  });

  it('records findingsCount 0 and run_trigger "hooks" for a failed-to-run scan (response null)', () => {
    const facts = emitScaAnalysisStats(SCA_CALLER_COMMANDS.gitPreCommit, null, 77, null);
    commitStatsFacts(facts);

    const [event] = readStatsEvents(testSonarUserHome);
    expect(event.caller_command).toBe('git-pre-commit');
    expect(event.exit_code).toBeNull();
    expect(event.run_trigger).toBe('hooks');
    expect(event.parsedDetails.analyzer).toBe('sca-scanner-cli');
    expect(event.parsedDetails.findingsCount).toBe(0);
  });

  it('re-scanning unchanged findings still reports the same raw count (no dedup for SCA)', () => {
    const response = makeResponse([makeRelease(true, [makeIssue('VULNERABILITY', 'HIGH')])]);

    commitStatsFacts(
      emitScaAnalysisStats(SCA_CALLER_COMMANDS.analyzeDependencyRisks, response, 10, 51),
    );
    commitStatsFacts(
      emitScaAnalysisStats(SCA_CALLER_COMMANDS.analyzeDependencyRisks, response, 10, 51),
    );

    const events = readStatsEvents(testSonarUserHome);
    expect(events).toHaveLength(2);
    expect(events[0].parsedDetails.findingsCount).toBe(1);
    expect(events[1].parsedDetails.findingsCount).toBe(1);
  });

  it('never throws when the underlying storage write fails (fire-and-forget)', () => {
    const facts: readonly StatsFact[] = emitScaAnalysisStats(
      SCA_CALLER_COMMANDS.analyzeDependencyRisks,
      null,
      100,
      null,
    );

    expect(() => commitStatsFacts(facts)).not.toThrow();
  });

  it('sanity check: the recorded payload shape matches AnalyzerStatsFactPayload', () => {
    const [fact] = emitScaAnalysisStats(SCA_CALLER_COMMANDS.analyzeDependencyRisks, null, 5, null);
    const payload = fact.payload as AnalyzerStatsFactPayload;

    expect(payload.envelope.analyzer).toBe('sca-scanner-cli');
    expect(payload.envelope.caller_command).toBe('analyze dependency-risks');
  });
});
