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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { SecretsJsonIssue } from '@/commands/analyze/secrets.ts';
import { printSecretsFindingsOrStderr } from '@/commands/hook/secrets-display.ts';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';

function printedLines(): string[] {
  return getMockUiCalls()
    .filter((c) => c.method === 'print')
    .map((c) => String(c.args[0]));
}

describe('printSecretsFindingsOrStderr', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    setMockUi(false);
  });

  it('formats a full finding with file, line, description, and masked secret', () => {
    const issue: SecretsJsonIssue = {
      ruleKey: 'aws-key',
      description: 'AWS key detected',
      file: 'src/config.ts',
      location: { startLine: 12, startColumn: 1, endLine: 12, endColumn: 20 },
      maskedSecret: 'AKIA****',
    };

    printSecretsFindingsOrStderr([issue], '');

    const [line] = printedLines();
    expect(line).toBe('  • src/config.ts:12 — AWS key detected (secret: AKIA****)');
  });

  it('omits the line suffix when location is missing', () => {
    const issue: SecretsJsonIssue = {
      ruleKey: 'aws-key',
      description: 'AWS key detected',
      file: 'src/config.ts',
      maskedSecret: 'AKIA****',
    };

    printSecretsFindingsOrStderr([issue], '');

    const [line] = printedLines();
    expect(line).toBe('  • src/config.ts — AWS key detected (secret: AKIA****)');
  });

  it('omits the masked-secret suffix when maskedSecret is missing', () => {
    const issue: SecretsJsonIssue = {
      ruleKey: 'aws-key',
      description: 'AWS key detected',
      file: 'src/config.ts',
      location: { startLine: 12, startColumn: 1, endLine: 12, endColumn: 20 },
    };

    printSecretsFindingsOrStderr([issue], '');

    const [line] = printedLines();
    expect(line).toBe('  • src/config.ts:12 — AWS key detected');
  });

  it('falls back to "(unknown)" when file is missing', () => {
    const issue: SecretsJsonIssue = {
      ruleKey: 'aws-key',
      description: 'AWS key detected',
    };

    printSecretsFindingsOrStderr([issue], '');

    const [line] = printedLines();
    expect(line).toBe('  • (unknown) — AWS key detected');
  });

  it('joins multiple findings on separate lines in a single print call', () => {
    const issues: SecretsJsonIssue[] = [
      { ruleKey: 'aws-key', description: 'AWS key detected', file: 'src/a.ts' },
      { ruleKey: 'gh-token', description: 'GitHub token detected', file: 'src/b.ts' },
    ];

    printSecretsFindingsOrStderr(issues, '');

    const calls = getMockUiCalls().filter((c) => c.method === 'print');
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.args[0])).toBe(
      '  • src/a.ts — AWS key detected\n  • src/b.ts — GitHub token detected',
    );
  });

  it('prints stderr when there are no issues but stderr is non-empty', () => {
    printSecretsFindingsOrStderr([], 'binary crashed');

    expect(printedLines()).toEqual(['binary crashed']);
  });

  it('prints nothing when there are no issues and stderr is empty', () => {
    printSecretsFindingsOrStderr([], '');

    expect(printedLines()).toEqual([]);
  });
});
