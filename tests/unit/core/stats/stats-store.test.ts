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

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { ENV_SONAR_USER_HOME, getStatsDir, STATS_DB_FILENAME } from '@/core/config-constants.ts';
import * as agentDetector from '@/core/host/environment/agent-detector.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import { queryStatsSummary } from '@/core/stats/stats-queries.ts';
import { dedupeAgainstSeen, recordAnalysisStats } from '@/core/stats/stats-store.ts';

function makeState(enabled: boolean) {
  const state = getDefaultState('1.0.0');
  state.telemetry.enabled = enabled;
  state.telemetry.installationId = 'install-id';
  return state;
}

let testSonarUserHome: string;
const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];

let loadStateSpy: ReturnType<typeof spyOn>;
let detectAgentSpy: ReturnType<typeof spyOn>;
let savedDoNotTrack: string | undefined;

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'cli-stats-store-test-'));
  process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;

  savedDoNotTrack = process.env.DO_NOT_TRACK;
  delete process.env.DO_NOT_TRACK;

  loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeState(true));
  detectAgentSpy = spyOn(agentDetector, 'detectCallerAgent').mockReturnValue(null);
});

afterEach(async () => {
  loadStateSpy.mockRestore();
  detectAgentSpy.mockRestore();

  if (savedDoNotTrack !== undefined) {
    process.env.DO_NOT_TRACK = savedDoNotTrack;
  } else {
    delete process.env.DO_NOT_TRACK;
  }

  await rm(testSonarUserHome, { recursive: true, force: true });
  if (previousSonarUserHome === undefined) {
    delete process.env[ENV_SONAR_USER_HOME];
  } else {
    process.env[ENV_SONAR_USER_HOME] = previousSonarUserHome;
  }
});

describe('dedupeAgainstSeen', () => {
  it('returns fingerprints not seen before, and remembers them for the next call', () => {
    expect(dedupeAgainstSeen('scope-a', ['fp1', 'fp2'])).toEqual(new Set(['fp1', 'fp2']));
    expect(dedupeAgainstSeen('scope-a', ['fp1', 'fp3'])).toEqual(new Set(['fp3']));
  });

  it('dedupes repeats within the same call', () => {
    expect(dedupeAgainstSeen('scope-b', ['fp1', 'fp1', 'fp2'])).toEqual(new Set(['fp1', 'fp2']));
  });

  it('keeps different scopes independent', () => {
    expect(dedupeAgainstSeen('scope-x', ['shared'])).toEqual(new Set(['shared']));
    expect(dedupeAgainstSeen('scope-y', ['shared'])).toEqual(new Set(['shared']));
  });
});

describe('recordAnalysisStats + queryStatsSummary', () => {
  it('records a run and surfaces it in the summary', () => {
    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze agentic',
      exitCode: 0,
      findingsCount: 15,
      ruleCounts: { 'java:S2259': 12, 'java:S1854': 3 },
    });

    const summary = queryStatsSummary(0);

    expect(summary.totalRuns).toBe(1);
    expect(summary.totalFindings).toBe(15);
    expect(summary.analyzers).toEqual([{ analyzer: 'sqaa', runs: 1, findings: 15 }]);
    expect(summary.triggers).toEqual([{ trigger: 'manual', runs: 1 }]);
    expect(summary.agentHitRate).toEqual({ runsWithFindings: 1, totalRuns: 1 });
    expect(summary.agentBreakdown).toEqual([{ agent: 'unidentified', runs: 1, findings: 15 }]);
    expect(summary.topRules).toEqual([{ ruleKey: 'java:S2259', count: 12, message: null }]);
    expect(summary.firstSeenMs).not.toBeNull();
  });

  it('only includes agents that actually ran, not every known agent', () => {
    detectAgentSpy.mockReturnValueOnce('claude').mockReturnValueOnce('cursor');
    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze agentic',
      exitCode: 0,
      findingsCount: 5,
    });
    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze agentic',
      exitCode: 0,
      findingsCount: 3,
    });

    const agents = [...queryStatsSummary(0).agentBreakdown]
      .map((a) => a.agent)
      .sort((a, b) => a.localeCompare(b));
    expect(agents).toEqual(['claude', 'cursor']);
  });

  it('breaks down runs by caller command', () => {
    recordAnalysisStats({
      analyzer: 'sonar-secrets',
      callerCommand: 'git-pre-commit',
      exitCode: 0,
      findingsCount: 0,
    });
    recordAnalysisStats({
      analyzer: 'sonar-secrets',
      callerCommand: 'git-pre-commit',
      exitCode: 0,
      findingsCount: 0,
    });
    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze agentic',
      exitCode: 0,
      findingsCount: 0,
    });

    const sorted = [...queryStatsSummary(0).callerCommandBreakdown].sort((a, b) =>
      a.command.localeCompare(b.command),
    );
    expect(sorted).toEqual([
      { command: 'analyze agentic', runs: 1 },
      { command: 'git-pre-commit', runs: 2 },
    ]);
  });

  it('hides a rule from "you keep hitting these issues" below the min-hits threshold', () => {
    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze agentic',
      exitCode: 0,
      findingsCount: 9,
      ruleCounts: { 'java:S2259': 9 },
    });

    expect(queryStatsSummary(0).topRules).toEqual([]);

    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze agentic',
      exitCode: 0,
      findingsCount: 1,
      ruleCounts: { 'java:S2259': 1 },
    });

    expect(queryStatsSummary(0).topRules).toEqual([
      { ruleKey: 'java:S2259', count: 10, message: null },
    ]);
  });

  it('surfaces a rule message once a hit rate has crossed the threshold, for both analyzers', () => {
    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze agentic',
      exitCode: 0,
      findingsCount: 10,
      ruleCounts: { 'java:S2259': 10 },
      ruleMessages: { 'java:S2259': 'Null pointer dereference' },
    });
    recordAnalysisStats({
      analyzer: 'sonar-secrets',
      callerCommand: 'git-pre-commit',
      exitCode: 51,
      findingsCount: 10,
      ruleCounts: { 'secrets:S6706': 10 },
      ruleMessages: { 'secrets:S6706': 'RSA Private Key' },
    });

    const sortedTopRules = [...queryStatsSummary(0).topRules].sort((a, b) =>
      a.ruleKey.localeCompare(b.ruleKey),
    );
    expect(sortedTopRules).toEqual([
      { ruleKey: 'java:S2259', count: 10, message: 'Null pointer dereference' },
      { ruleKey: 'secrets:S6706', count: 10, message: 'RSA Private Key' },
    ]);
  });

  it('classifies hook caller commands as hooks, not manual', () => {
    recordAnalysisStats({
      analyzer: 'sonar-secrets',
      callerCommand: 'git-pre-commit',
      exitCode: 0,
      findingsCount: 0,
    });

    const summary = queryStatsSummary(0);
    expect(summary.triggers).toEqual([{ trigger: 'hooks', runs: 1 }]);
  });

  it('maps blocked secrets runs to their stop point', () => {
    recordAnalysisStats({
      analyzer: 'sonar-secrets',
      callerCommand: 'git-pre-commit',
      exitCode: 51,
      findingsCount: 1,
    });
    recordAnalysisStats({
      analyzer: 'sonar-secrets',
      callerCommand: 'git-pre-push',
      exitCode: 51,
      findingsCount: 1,
    });
    recordAnalysisStats({
      analyzer: 'sonar-secrets',
      callerCommand: 'analyze secrets',
      exitCode: 51,
      findingsCount: 1,
    });

    const summary = queryStatsSummary(0);
    const sortedStopped = [...summary.stopped].sort((a, b) => a.point.localeCompare(b.point));
    expect(sortedStopped).toEqual([
      { point: 'commit', count: 1 },
      { point: 'push', count: 1 },
    ]);
    const blockedTotal = summary.dailySecretsBlocked.reduce((sum, d) => sum + d.count, 0);
    expect(blockedTotal).toBe(2);
  });

  it('surfaces the top 2 secret types by hit count, bucketing the rest into "others"', () => {
    recordAnalysisStats({
      analyzer: 'sonar-secrets',
      callerCommand: 'git-pre-commit',
      exitCode: 51,
      findingsCount: 6,
      ruleCounts: { 'secrets:S6290': 3, 'secrets:S6710': 2, 'secrets:S2068': 1 },
      ruleMessages: {
        'secrets:S6290': 'AWS access keys should not be disclosed',
        'secrets:S6710': 'GitHub tokens should not be disclosed',
        'secrets:S2068': 'Hardcoded password',
      },
    });

    expect(queryStatsSummary(0).topSecretTypes).toEqual([
      { label: 'AWS access keys', count: 3 },
      { label: 'GitHub tokens', count: 2 },
      { label: 'others', count: 1 },
    ]);
  });

  it('omits the "others" bucket when there are 2 or fewer secret types', () => {
    recordAnalysisStats({
      analyzer: 'sonar-secrets',
      callerCommand: 'git-pre-commit',
      exitCode: 51,
      findingsCount: 4,
      ruleCounts: { 'secrets:S6290': 3, 'secrets:S6710': 1 },
      ruleMessages: {
        'secrets:S6290': 'AWS access keys should not be disclosed',
        'secrets:S6710': 'GitHub tokens should not be disclosed',
      },
    });

    expect(queryStatsSummary(0).topSecretTypes).toEqual([
      { label: 'AWS access keys', count: 3 },
      { label: 'GitHub tokens', count: 1 },
    ]);
  });

  it('buckets dependency-risk findings by day', () => {
    recordAnalysisStats({
      analyzer: 'sca-scanner-cli',
      callerCommand: 'analyze dependency-risks',
      exitCode: 0,
      findingsCount: 4,
      ruleCounts: { 'VULNERABILITY:HIGH': 4 },
    });

    const summary = queryStatsSummary(0);
    expect(summary.dailyDependencyRisks).toHaveLength(1);
    expect(summary.dailyDependencyRisks[0].count).toBe(4);
  });

  it('does nothing when telemetry consent is off', () => {
    loadStateSpy.mockReturnValue(makeState(false));

    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze',
      exitCode: 0,
      findingsCount: 5,
    });

    const summary = queryStatsSummary(0);
    expect(summary.totalRuns).toBe(0);
    expect(summary.totalFindings).toBe(0);
  });

  it('creates a fresh ledger at the current schema version and persists duration_ms', () => {
    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze agentic',
      exitCode: 0,
      durationMs: 4321,
      findingsCount: 1,
    });

    const db = new Database(join(getStatsDir(), STATS_DB_FILENAME), { readonly: true });
    try {
      const versionRow = db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(versionRow.user_version).toBeGreaterThan(0);

      const row = db.prepare('SELECT duration_ms FROM stats_events').get() as {
        duration_ms: number | null;
      };
      expect(row.duration_ms).toBe(4321);
    } finally {
      db.close();
    }
  });

  it('wipes and recreates the ledger on a schema version mismatch, instead of migrating in place', () => {
    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze agentic',
      exitCode: 0,
      findingsCount: 1,
    });
    expect(queryStatsSummary(0).totalRuns).toBe(1);

    const dbPath = join(getStatsDir(), STATS_DB_FILENAME);
    const db = new Database(dbPath);
    db.run('PRAGMA user_version = 999999');
    db.close();

    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze agentic',
      exitCode: 0,
      findingsCount: 7,
    });

    const summary = queryStatsSummary(0);
    expect(summary.totalRuns).toBe(1);
    expect(summary.totalFindings).toBe(7);
  });

  it('never throws when the underlying storage write fails', async () => {
    const brokenHome = join(testSonarUserHome, 'not-a-directory');
    await writeFile(brokenHome, 'not a directory');
    process.env[ENV_SONAR_USER_HOME] = brokenHome;

    expect(() =>
      recordAnalysisStats({
        analyzer: 'sqaa',
        callerCommand: 'analyze',
        exitCode: 0,
        findingsCount: 1,
      }),
    ).not.toThrow();
  });

  it('excludes runs before the requested since window', () => {
    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze',
      exitCode: 0,
      findingsCount: 1,
    });

    const summary = queryStatsSummary(Date.now() + 60_000);
    expect(summary.totalRuns).toBe(0);
    expect(summary.firstSeenMs).not.toBeNull();
  });

  it('counts a run outside the requested window in allTime but not in the windowed totals', () => {
    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze',
      exitCode: 0,
      findingsCount: 7,
    });

    const summary = queryStatsSummary(Date.now() + 60_000);
    expect(summary.totalRuns).toBe(0);
    expect(summary.totalFindings).toBe(0);
    expect(summary.allTime.totalRuns).toBe(1);
    expect(summary.allTime.totalFindings).toBe(7);
  });

  it('breaks down agents and hit rate across every analyzer, not only sqaa', () => {
    recordAnalysisStats({
      analyzer: 'sqaa',
      callerCommand: 'analyze agentic',
      exitCode: 0,
      findingsCount: 3,
    });
    detectAgentSpy.mockReturnValue('cursor');
    recordAnalysisStats({
      analyzer: 'sca-scanner-cli',
      callerCommand: 'analyze dependency-risks',
      exitCode: 0,
      findingsCount: 2,
      ruleCounts: { 'VULNERABILITY:HIGH': 2 },
    });

    const summary = queryStatsSummary(0);
    const sortedAgents = [...summary.agentBreakdown].sort((a, b) => a.agent.localeCompare(b.agent));
    expect(sortedAgents).toEqual([
      { agent: 'cursor', runs: 1, findings: 2 },
      { agent: 'unidentified', runs: 1, findings: 3 },
    ]);
    expect(summary.agentHitRate).toEqual({ runsWithFindings: 2, totalRuns: 2 });
  });
});
