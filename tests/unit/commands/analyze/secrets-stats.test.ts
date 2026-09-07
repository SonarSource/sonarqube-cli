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

import {
  buildSecretsFingerprint,
  type SecretsJsonIssue,
  summarizeNewSecretsFindings,
} from '@/commands/analyze/secrets.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';

function makeIssue(overrides: Partial<SecretsJsonIssue> & { ruleKey: string }): SecretsJsonIssue {
  return { description: 'A secret', ...overrides };
}

let testSonarUserHome: string;
const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];
let loadStateSpy: ReturnType<typeof spyOn>;
let savedDoNotTrack: string | undefined;

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'cli-secrets-stats-test-'));
  process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;

  savedDoNotTrack = process.env.DO_NOT_TRACK;
  delete process.env.DO_NOT_TRACK;

  const state = getDefaultState('1.0.0');
  state.telemetry.enabled = true;
  state.telemetry.installationId = 'install-id';
  loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(state);
});

afterEach(async () => {
  loadStateSpy.mockRestore();
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

describe('buildSecretsFingerprint', () => {
  it('composes rule, file, and location into one key', () => {
    expect(buildSecretsFingerprint('secrets:S6290', 'a.env', 3, 1)).toBe('secrets:S6290|a.env|3|1');
  });

  it('tolerates a missing file/location (stdin scans)', () => {
    expect(buildSecretsFingerprint('secrets:S6290', undefined, undefined, undefined)).toBe(
      'secrets:S6290|||',
    );
  });
});

describe('summarizeNewSecretsFindings', () => {
  it('dedupes repeats within the same run, and tallies survivors by rule', () => {
    const tenDistinctFindings = Array.from({ length: 10 }, (_, i) =>
      makeIssue({
        ruleKey: 'secrets:S6290',
        description: 'AWS Access Key',
        file: `file-${i}.env`,
        location: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 },
      }),
    );
    const result = summarizeNewSecretsFindings([...tenDistinctFindings, tenDistinctFindings[0]]);

    expect(result.findingsCount).toBe(10);
    expect(result.ruleCounts).toEqual({ 'secrets:S6290': 10 });
    expect(result.ruleMessages).toEqual({ 'secrets:S6290': 'AWS Access Key' });
  });

  it('does not double-count the same secret across repeat runs, including its rule tally', () => {
    const finding = makeIssue({
      ruleKey: 'secrets:S6290',
      description: 'AWS Access Key',
      file: 'a.env',
      location: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 10 },
    });

    const first = summarizeNewSecretsFindings([finding]);
    expect(first.findingsCount).toBe(1);
    expect(first.ruleCounts).toEqual({ 'secrets:S6290': 1 });

    const second = summarizeNewSecretsFindings([finding]);
    expect(second.findingsCount).toBe(0);
    expect(second.ruleCounts).toEqual({});
    expect(second.ruleMessages).toEqual({ 'secrets:S6290': 'AWS Access Key' });
  });

  it('still counts a genuinely new finding on a repeat run', () => {
    const seen = makeIssue({ ruleKey: 'secrets:S6290', file: 'a.env' });
    summarizeNewSecretsFindings([seen]);

    const newFinding = makeIssue({ ruleKey: 'secrets:S6290', file: 'b.env' });
    const result = summarizeNewSecretsFindings([seen, newFinding]);

    expect(result.findingsCount).toBe(1);
    expect(result.ruleCounts).toEqual({ 'secrets:S6290': 1 });
  });
});
