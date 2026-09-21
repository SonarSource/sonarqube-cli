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

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  buildSecretsFingerprint,
  summarizeNewSecretsFindings,
} from '@/commands/analyze/secrets.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';

import { removeTestSonarUserHome } from '../../../_common/stats-helpers.ts';

let testSonarUserHome: string;
const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'cli-secrets-stats-test-'));
  process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;
});

afterEach(async () => {
  await removeTestSonarUserHome(testSonarUserHome);
  if (previousSonarUserHome === undefined) {
    delete process.env[ENV_SONAR_USER_HOME];
  } else {
    process.env[ENV_SONAR_USER_HOME] = previousSonarUserHome;
  }
});

describe('buildSecretsFingerprint', () => {
  it('composes rule/file/line/column into one key', () => {
    expect(buildSecretsFingerprint('secrets:S6290', 'src/config.ts', 3, 14)).toBe(
      'secrets:S6290|src/config.ts|3|14',
    );
  });

  it('tolerates missing file/location (stdin mode)', () => {
    expect(buildSecretsFingerprint('secrets:S6290', undefined, undefined, undefined)).toBe(
      'secrets:S6290|||',
    );
  });
});

describe('summarizeNewSecretsFindings', () => {
  it('returns findingsCount 0 and no ruleCounts for an empty issue list', () => {
    expect(summarizeNewSecretsFindings([])).toEqual({ findingsCount: 0 });
  });

  it('counts every issue as new the first time it is seen', () => {
    const result = summarizeNewSecretsFindings([
      {
        ruleKey: 'secrets:S6290',
        description: 'AWS Access Key detected',
        file: 'src/config.ts',
        location: { startLine: 3, startColumn: 14, endLine: 3, endColumn: 48 },
      },
    ]);

    expect(result.findingsCount).toBe(1);
    expect(result.ruleCounts).toEqual({ 'secrets:S6290': 1 });
  });

  it('dedupes the same finding on a re-scan of the same unchanged file', () => {
    const issue = {
      ruleKey: 'secrets:S6290',
      description: 'AWS Access Key detected',
      file: 'src/config.ts',
      location: { startLine: 3, startColumn: 14, endLine: 3, endColumn: 48 },
    };

    summarizeNewSecretsFindings([issue]);
    const second = summarizeNewSecretsFindings([issue]);

    expect(second).toEqual({ findingsCount: 0 });
  });

  it('reports a genuinely new finding even after a previous run reported a different one', () => {
    const first = {
      ruleKey: 'secrets:S6290',
      description: 'AWS Access Key detected',
      file: 'src/config.ts',
      location: { startLine: 3, startColumn: 14, endLine: 3, endColumn: 48 },
    };
    const second = {
      ruleKey: 'secrets:S6290',
      description: 'AWS Access Key detected',
      file: 'src/other.ts',
      location: { startLine: 3, startColumn: 14, endLine: 3, endColumn: 48 },
    };

    summarizeNewSecretsFindings([first]);
    const result = summarizeNewSecretsFindings([second]);

    expect(result.findingsCount).toBe(1);
    expect(result.ruleCounts).toEqual({ 'secrets:S6290': 1 });
  });

  it('dedupes repeated identical fingerprints within the same scan', () => {
    const issue = {
      ruleKey: 'secrets:S6290',
      description: 'AWS Access Key detected',
      file: 'src/config.ts',
      location: { startLine: 3, startColumn: 14, endLine: 3, endColumn: 48 },
    };

    const result = summarizeNewSecretsFindings([issue, issue]);

    expect(result.findingsCount).toBe(1);
    expect(result.ruleCounts).toEqual({ 'secrets:S6290': 1 });
  });

  it('does not collide two --input scans with no file when their `source` differs', () => {
    // Same rule/line/column, no `file` — exactly what sonar-secrets reports for stdin/--input
    // scans. Without a distinguishing `source`, the second prompt's finding would be wrongly
    // treated as already seen.
    const issue = {
      ruleKey: 'secrets:S6290',
      description: 'AWS Access Key detected',
      location: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 20 },
    };

    summarizeNewSecretsFindings([issue], 'prompt-hash-a');
    const result = summarizeNewSecretsFindings([issue], 'prompt-hash-b');

    expect(result.findingsCount).toBe(1);
  });

  it('still dedupes an --input scan of the same source on re-scan', () => {
    const issue = {
      ruleKey: 'secrets:S6290',
      description: 'AWS Access Key detected',
      location: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 20 },
    };

    summarizeNewSecretsFindings([issue], 'prompt-hash-a');
    const result = summarizeNewSecretsFindings([issue], 'prompt-hash-a');

    expect(result).toEqual({ findingsCount: 0 });
  });
});
