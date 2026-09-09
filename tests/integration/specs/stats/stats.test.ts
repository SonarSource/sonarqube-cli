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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { StatsEntitlement } from '@/commands/stats/index.ts';
import { ENV_DO_NOT_TRACK, ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import * as agentDetector from '@/core/host/environment/agent-detector.ts';
import type { StatsSummary } from '@/core/stats/stats-queries.ts';
import { openStatsDb, recordAnalysisStats } from '@/core/stats/stats-store.ts';

import { TestHarness } from '../../harness';

const DAY_MS = 24 * 60 * 60 * 1000;

type StatsJsonOutput = StatsSummary & { entitlement: StatsEntitlement | null };

/**
 * recordAnalysisStats/openStatsDb resolve their target directory from
 * SONAR_USER_HOME at call time. Point that at the harness's own sonar home
 * (already materialized on disk via harness.env()) so seeding writes to the
 * exact ledger file the spawned CLI process will read.
 */
function seedIntoHarnessLedger(harness: TestHarness, seed: () => void): void {
  const previousHome = process.env[ENV_SONAR_USER_HOME];
  const previousDnt = process.env[ENV_DO_NOT_TRACK];
  process.env[ENV_SONAR_USER_HOME] = harness.sonarUserHome.path;
  delete process.env[ENV_DO_NOT_TRACK];
  try {
    seed();
  } finally {
    if (previousHome === undefined) delete process.env[ENV_SONAR_USER_HOME];
    else process.env[ENV_SONAR_USER_HOME] = previousHome;
    if (previousDnt === undefined) delete process.env[ENV_DO_NOT_TRACK];
    else process.env[ENV_DO_NOT_TRACK] = previousDnt;
  }
}

function seedEventAt(params: {
  timestampMs: number;
  analyzer: string;
  findingsCount: number;
}): void {
  const db = openStatsDb();
  try {
    const { lastInsertRowid: eventId } = db
      .prepare(
        `INSERT INTO stats_events (timestamp_ms, event_class, caller_command, exit_code, caller_agent, run_trigger, duration_ms)
         VALUES (?, 'analyzer', 'analyze', 0, 'unidentified', 'manual', NULL)`,
      )
      .run(params.timestampMs);
    db.prepare(
      'INSERT INTO analyzer_event_details (event_id, analyzer, findings_count) VALUES (?, ?, ?)',
    ).run(eventId, params.analyzer, params.findingsCount);
  } finally {
    db.close();
  }
}

describe('sonar stats', () => {
  let harness: TestHarness;
  let detectAgentSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    harness = await TestHarness.create();
    detectAgentSpy = spyOn(agentDetector, 'detectCallerAgent').mockReturnValue(null);
  });

  afterEach(async () => {
    detectAgentSpy.mockRestore();
    await harness.dispose();
  });

  it('shows the day-0 empty state without auth or a network call', async () => {
    const result = await harness.run('stats');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('nothing recorded yet');
    expect(result.stdout).toContain('sonar integrate');
  });

  it('renders the summary card, secrets breakdown and top rules from a seeded ledger', async () => {
    harness.state().withTelemetryEnabled();
    harness.env();

    seedIntoHarnessLedger(harness, () => {
      recordAnalysisStats({
        analyzer: 'sqaa',
        callerCommand: 'analyze agentic',
        exitCode: 0,
        findingsCount: 12,
        ruleCounts: { 'java:S2259': 12 },
        ruleMessages: { 'java:S2259': 'Null pointers should not be dereferenced' },
      });
      recordAnalysisStats({
        analyzer: 'sonar-secrets',
        callerCommand: 'git-pre-commit',
        exitCode: 51,
        findingsCount: 1,
        ruleCounts: { 'secrets:S6290': 1 },
        ruleMessages: { 'secrets:S6290': 'AWS access keys should not be disclosed' },
      });
      recordAnalysisStats({
        analyzer: 'sca-scanner-cli',
        callerCommand: 'analyze dependency-risks',
        exitCode: 0,
        findingsCount: 3,
        ruleCounts: { 'VULNERABILITY:HIGH': 3 },
      });
    });

    const result = await harness.run('stats');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Analyses run');
    expect(result.stdout).toContain('Issues caught');
    expect(result.stdout).toContain('Secrets blocked · 1 total');
    expect(result.stdout).toContain('AWS access keys');
    expect(result.stdout).toContain('vortex analysis');
    expect(result.stdout).toContain('dependency risks');
    expect(result.stdout).toContain('You keep hitting these issues');
    expect(result.stdout).toContain('Null pointers should not be dereferenced');
    expect(result.stdout).toContain('ran from hooks');
  });

  it('emits the documented --json shape from the same seeded ledger', async () => {
    harness.state().withTelemetryEnabled();
    harness.env();

    seedIntoHarnessLedger(harness, () => {
      recordAnalysisStats({
        analyzer: 'sqaa',
        callerCommand: 'analyze agentic',
        exitCode: 0,
        findingsCount: 12,
        ruleCounts: { 'java:S2259': 12 },
        ruleMessages: { 'java:S2259': 'Null pointers should not be dereferenced' },
      });
      recordAnalysisStats({
        analyzer: 'sonar-secrets',
        callerCommand: 'git-pre-commit',
        exitCode: 51,
        findingsCount: 1,
        ruleCounts: { 'secrets:S6290': 1 },
        ruleMessages: { 'secrets:S6290': 'AWS access keys should not be disclosed' },
      });
    });

    const result = await harness.run('stats --json');
    expect(result.exitCode).toBe(0);

    const json = JSON.parse(result.stdout) as StatsJsonOutput;
    expect(json.totalRuns).toBe(2);
    expect(json.totalFindings).toBe(13);
    expect(json.allTime).toEqual({
      totalRuns: 2,
      totalFindings: 13,
      secretsBlockedTotal: 1,
      dependencyRisksTotal: 0,
    });
    expect([...json.analyzers].sort((a, b) => a.analyzer.localeCompare(b.analyzer))).toEqual([
      { analyzer: 'sonar-secrets', runs: 1, findings: 1 },
      { analyzer: 'sqaa', runs: 1, findings: 12 },
    ]);
    expect(json.stopped).toEqual([{ point: 'commit', count: 1 }]);
    expect(json.topSecretTypes).toEqual([{ label: 'AWS access keys', count: 1 }]);
    expect(json.entitlement).toEqual({ vortexNotEntitled: false, scaNotEnabled: false });
  });

  it('keeps a run outside the --since window out of the windowed totals but in allTime', async () => {
    harness.state().withTelemetryEnabled();
    harness.env();

    seedIntoHarnessLedger(harness, () => {
      seedEventAt({
        timestampMs: Date.now() - 40 * DAY_MS,
        analyzer: 'sca-scanner-cli',
        findingsCount: 5,
      });
      recordAnalysisStats({
        analyzer: 'sqaa',
        callerCommand: 'analyze agentic',
        exitCode: 0,
        findingsCount: 2,
      });
    });

    const windowed = JSON.parse(
      (await harness.run('stats --since 30d --json')).stdout,
    ) as StatsJsonOutput;
    expect(windowed.totalRuns).toBe(1);
    expect(windowed.totalFindings).toBe(2);
    expect(windowed.allTime).toEqual({
      totalRuns: 2,
      totalFindings: 7,
      secretsBlockedTotal: 0,
      dependencyRisksTotal: 5,
    });

    const allTime = JSON.parse(
      (await harness.run('stats --since all --json')).stdout,
    ) as StatsJsonOutput;
    expect(allTime.totalRuns).toBe(2);
    expect(allTime.totalFindings).toBe(7);
  });
});
