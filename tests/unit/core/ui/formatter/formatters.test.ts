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

// Unit tests for CSV formatter

import { describe, expect, it } from 'bun:test';

import type { SonarQubeIssue } from '@/core/server/types.ts';
import { formatCSV } from '@/core/ui/formatter/csv.ts';

function makeIssue(overrides: Partial<SonarQubeIssue> = {}): SonarQubeIssue {
  return {
    key: 'issue-1',
    rule: 'typescript:S1234',
    severity: 'MAJOR',
    component: 'my-project:src/file.ts',
    project: 'my-project',
    status: 'OPEN',
    message: 'Test issue message',
    type: 'BUG',
    ...overrides,
  };
}

// ─── formatCSV ────────────────────────────────────────────────────────────────

describe('formatCSV: header', () => {
  it('always outputs header as first line', () => {
    const first = formatCSV([]).split('\n')[0];
    expect(first).toBe('severity,rule,message,file,line,type,status');
  });

  it('returns only header when issues array is empty', () => {
    const lines = formatCSV([]).split('\n');
    expect(lines).toHaveLength(1);
  });
});

describe('formatCSV: data rows', () => {
  it('produces one row per issue after header', () => {
    const result = formatCSV([makeIssue(), makeIssue()]);
    expect(result.split('\n')).toHaveLength(3); // header + 2 rows
  });

  it('row contains all fields in correct order', () => {
    const issue = makeIssue({
      severity: 'CRITICAL',
      rule: 'r1',
      message: 'msg',
      type: 'BUG',
      status: 'OPEN',
      line: 5,
    });
    const row = formatCSV([issue]).split('\n')[1];
    const parts = row.split(',');
    expect(parts[0]).toBe('CRITICAL');
    expect(parts[1]).toBe('r1');
    expect(parts[2]).toBe('msg');
    expect(parts[4]).toBe('5');
    expect(parts[5]).toBe('BUG');
    expect(parts[6]).toBe('OPEN');
  });

  it('extracts filename from component', () => {
    const result = formatCSV([makeIssue({ component: 'proj:src/auth.ts' })]);
    const row = result.split('\n')[1];
    expect(row).toContain('src/auth.ts');
    expect(row).not.toContain('proj:src');
  });

  it('empty string for undefined line number', () => {
    const issue = makeIssue();
    delete issue.line;
    const row = formatCSV([issue]).split('\n')[1];
    const parts = row.split(',');
    expect(parts[4]).toBe('');
  });
});

describe('formatCSV: escaping', () => {
  it('wraps value in quotes when it contains a comma', () => {
    const result = formatCSV([makeIssue({ message: 'foo,bar' })]);
    expect(result).toContain('"foo,bar"');
  });

  it('escapes double quotes by doubling them', () => {
    const result = formatCSV([makeIssue({ message: 'say "hello"' })]);
    expect(result).toContain('"say ""hello"""');
  });

  it('wraps value in quotes when it contains a newline', () => {
    const result = formatCSV([makeIssue({ message: 'line1\nline2' })]);
    expect(result).toContain('"line1\nline2"');
  });

  it('does not quote plain values without special characters', () => {
    const result = formatCSV([makeIssue({ message: 'simple message' })]);
    expect(result).not.toContain('"simple message"');
    expect(result).toContain('simple message');
  });
});
