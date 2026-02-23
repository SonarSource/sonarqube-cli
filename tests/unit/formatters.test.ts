// Unit tests for table and CSV formatters

import { describe, it, expect } from 'bun:test';
import { formatTable } from '../../src/formatter/table.js';
import { formatCSV } from '../../src/formatter/csv.js';
import type { SonarQubeIssue } from '../../src/lib/types.js';

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

// ─── formatTable ──────────────────────────────────────────────────────────────

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
    const result = formatTable([makeIssue({ severity: 'CRITICAL', rule: 'java:S001', message: 'Fix me' })]);
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
    // header + separator + 3 rows = 5 lines
    expect(lines).toHaveLength(5);
  });

  it('expands column widths when content exceeds minimum', () => {
    const longRule = 'a'.repeat(40); // > MIN_RULE_WIDTH of 15
    const result = formatTable([makeIssue({ rule: longRule })]);
    expect(result).toContain(longRule);
  });
});

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
    const issue = makeIssue({ severity: 'HIGH', rule: 'r1', message: 'msg', type: 'BUG', status: 'OPEN', line: 5 });
    const row = formatCSV([issue]).split('\n')[1];
    const parts = row.split(',');
    expect(parts[0]).toBe('HIGH');
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
