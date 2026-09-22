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

import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { describe, expect, it, spyOn } from 'bun:test';

import { ENV_SONAR_USER_HOME, getStatsDir, STATS_DB_FILENAME } from '@/core/config-constants.ts';
import * as dbModule from '@/core/stats/db.ts';
import { dedupeAgainstSeen, recordStatsEvent, upsertRuleMessages } from '@/core/stats/store.ts';

import { readStatsAggregate } from '../../../_common/stats-helpers.ts';
import { useTempSonarUserHome } from './_helpers.ts';

useTempSonarUserHome('cli-stats-store-test-');

function readAggregate(dimension: string, key: string): { runs: number; findings: number } | null {
  return readStatsAggregate(process.env[ENV_SONAR_USER_HOME] as string, dimension, key);
}

function readEvents(): Array<{
  timestamp_ms: number;
  event_class: string;
  caller_command: string;
  exit_code: number | null;
  caller_agent: string;
  run_trigger: string;
  duration_ms: number | null;
  details: string;
}> {
  const db = new Database(join(getStatsDir(), STATS_DB_FILENAME), { readonly: true });
  try {
    return db.prepare('SELECT * FROM stats_events').all() as never;
  } finally {
    db.close();
  }
}

describe('recordStatsEvent', () => {
  it('writes the envelope and details as a single row', () => {
    recordStatsEvent(
      {
        callerCommand: 'analyze agentic',
        exitCode: 0,
        callerAgent: 'claude',
        runTrigger: 'manual',
        durationMs: 4321,
      },
      {
        eventClass: 'analyzer',
        analyzer: 'sqaa',
        findingsCount: 3,
        ruleCounts: { 'java:S2259': 3 },
      },
    );

    const [row] = readEvents();
    expect(row.event_class).toBe('analyzer');
    expect(row.caller_command).toBe('analyze agentic');
    expect(row.exit_code).toBe(0);
    expect(row.caller_agent).toBe('claude');
    expect(row.run_trigger).toBe('manual');
    expect(row.duration_ms).toBe(4321);
    expect(JSON.parse(row.details)).toEqual({
      eventClass: 'analyzer',
      analyzer: 'sqaa',
      findingsCount: 3,
      ruleCounts: { 'java:S2259': 3 },
    });
  });

  it('rolls the event into stats_aggregates alongside the raw row', () => {
    recordStatsEvent(
      {
        callerCommand: 'analyze agentic',
        exitCode: 0,
        callerAgent: 'claude',
        runTrigger: 'manual',
      },
      {
        eventClass: 'analyzer',
        analyzer: 'sqaa',
        findingsCount: 3,
        ruleCounts: { 'java:S2259': 3 },
      },
    );

    expect(readAggregate('global', '')).toMatchObject({ runs: 1, findings: 3 });
    expect(readAggregate('analyzer', 'sqaa')).toMatchObject({ runs: 1, findings: 3 });
    expect(readAggregate('agent', 'claude')).toMatchObject({ runs: 1, findings: 3 });
    expect(readAggregate('trigger', 'manual')).toMatchObject({ runs: 1, findings: 0 });
    expect(readAggregate('caller_command', 'analyze agentic')).toMatchObject({
      runs: 1,
      findings: 0,
    });
    expect(readAggregate('rule', 'sqaa:java:S2259')).toMatchObject({ runs: 0, findings: 3 });
  });

  it('defaults an omitted durationMs to null', () => {
    recordStatsEvent(
      {
        callerCommand: 'git-pre-commit',
        exitCode: 51,
        callerAgent: 'unidentified',
        runTrigger: 'hooks',
      },
      { eventClass: 'analyzer', analyzer: 'sonar-secrets', findingsCount: 1 },
    );

    expect(readEvents()[0].duration_ms).toBeNull();
  });
});

describe('upsertRuleMessages', () => {
  it('inserts a new rule message', () => {
    upsertRuleMessages({ 'java:S2259': 'Null pointer dereference' });

    const db = new Database(join(getStatsDir(), STATS_DB_FILENAME), { readonly: true });
    try {
      const row = db
        .prepare('SELECT message FROM rule_descriptions WHERE rule_key = ?')
        .get('java:S2259') as {
        message: string;
      };
      expect(row.message).toBe('Null pointer dereference');
    } finally {
      db.close();
    }
  });

  it('updates the message on conflict', () => {
    upsertRuleMessages({ 'java:S2259': 'Old message' });
    upsertRuleMessages({ 'java:S2259': 'New message' });

    const db = new Database(join(getStatsDir(), STATS_DB_FILENAME), { readonly: true });
    try {
      const row = db
        .prepare('SELECT message FROM rule_descriptions WHERE rule_key = ?')
        .get('java:S2259') as {
        message: string;
      };
      expect(row.message).toBe('New message');
    } finally {
      db.close();
    }
  });
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

describe('withDb: best-effort like telemetry, never breaks the calling command', () => {
  it('recordStatsEvent swallows a ledger-open failure instead of throwing', () => {
    const spy = spyOn(dbModule, 'openStatsDb').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() =>
      recordStatsEvent(
        { callerCommand: 'analyze', exitCode: 0, callerAgent: 'claude', runTrigger: 'manual' },
        { eventClass: 'analyzer', analyzer: 'sonar-secrets', findingsCount: 0 },
      ),
    ).not.toThrow();

    spy.mockRestore();
  });

  it('upsertRuleMessages swallows a ledger-open failure instead of throwing', () => {
    const spy = spyOn(dbModule, 'openStatsDb').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => upsertRuleMessages({ 'java:S2259': 'Null pointer dereference' })).not.toThrow();

    spy.mockRestore();
  });

  it('dedupeAgainstSeen falls back to "everything is new" on a ledger-open failure', () => {
    const spy = spyOn(dbModule, 'openStatsDb').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(dedupeAgainstSeen('scope', ['fp1', 'fp2'])).toEqual(new Set(['fp1', 'fp2']));

    spy.mockRestore();
  });

  it('closes the connection and swallows the error when the write itself fails', () => {
    const closeSpy = spyOn(Database.prototype, 'close');
    const prepareSpy = spyOn(Database.prototype, 'prepare').mockImplementation(() => {
      throw new Error('malformed database schema');
    });

    expect(() => upsertRuleMessages({ 'java:S2259': 'Null pointer dereference' })).not.toThrow();
    expect(closeSpy).toHaveBeenCalled();

    prepareSpy.mockRestore();
    closeSpy.mockRestore();
  });
});
