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

import { describe, expect, it } from 'bun:test';

import { formatTable } from '@/commands/list/issues.ts';
import type { SonarQubeIssue } from '@/core/server/types.ts';

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

describe('formatTable: empty input', () => {
  it('returns "No issues found" for empty array', () => {
    expect(formatTable([])).toBe('No issues found');
  });
});

describe('formatTable: structure', () => {
  it('output contains a header line with column names', () => {
    const result = formatTable([makeIssue()]);
    const lines = result.split('\n');
    expect(lines[0]).toContain('SEVERITY');
    expect(lines[0]).toContain('RULE');
    expect(lines[0]).toContain('MESSAGE');
    expect(lines[0]).toContain('FILE');
  });

  it('output has a separator line after header', () => {
    const result = formatTable([makeIssue()]);
    const lines = result.split('\n');
    expect(lines[1]).toMatch(/^-+$/);
  });

  it('data row contains issue severity, rule, and message', () => {
    const result = formatTable([
      makeIssue({ severity: 'CRITICAL', rule: 'java:S001', message: 'Fix me' }),
    ]);
    const dataRow = result.split('\n')[2];
    expect(dataRow).toContain('CRITICAL');
    expect(dataRow).toContain('java:S001');
    expect(dataRow).toContain('Fix me');
  });

  it('extracts filename from component using colon separator', () => {
    const result = formatTable([makeIssue({ component: 'proj:src/utils/helper.ts' })]);
    expect(result).toContain('src/utils/helper.ts');
    expect(result).not.toContain('proj:src');
  });

  it('uses full component when no colon separator present', () => {
    const result = formatTable([makeIssue({ component: 'standalone-component' })]);
    expect(result).toContain('standalone-component');
  });

  it('shows line number when present', () => {
    const result = formatTable([makeIssue({ line: 42 })]);
    expect(result).toContain(':42');
  });

  it('shows ? when line number is absent', () => {
    const issue = makeIssue();
    delete issue.line;
    const result = formatTable([issue]);
    expect(result).toContain(':?');
  });

  it('produces one data row per issue', () => {
    const issues = [makeIssue({ key: 'a' }), makeIssue({ key: 'b' }), makeIssue({ key: 'c' })];
    const lines = formatTable(issues).split('\n');
    expect(lines).toHaveLength(5);
  });

  it('expands column widths when content exceeds minimum', () => {
    const longRule = 'a'.repeat(40);
    const result = formatTable([makeIssue({ rule: longRule })]);
    expect(result).toContain(longRule);
  });
});
