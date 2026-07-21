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

import type { SqaaJsonReport } from '../../../../src/commands/analyze/sqaa-display.ts';
import { formatSqaaJsonReportForHook } from '../../../../src/commands/hook/format-sqaa-hook-context.ts';

function emptyReport(overrides: Partial<SqaaJsonReport> = {}): SqaaJsonReport {
  return {
    files: [],
    ignored: [],
    failures: [],
    skipped: [],
    summary: { totalIssues: 0, totalFailures: 0, totalSkipped: 0 },
    analysisDepth: 'STANDARD',
    ...overrides,
  };
}

describe('formatSqaaJsonReportForHook', () => {
  it('returns null for an empty change set', () => {
    expect(formatSqaaJsonReportForHook(emptyReport())).toBeNull();
  });

  it('surfaces skipped files when analysis did not complete any file', () => {
    expect(
      formatSqaaJsonReportForHook(
        emptyReport({
          skipped: ['src/a.ts', 'src/b.ts'],
          summary: { totalIssues: 0, totalFailures: 0, totalSkipped: 2 },
        }),
      ),
    ).toBe('Skipped 2 file(s) (analysis not completed).');
  });

  it('surfaces per-file analysis errors when totalIssues is zero', () => {
    const text = formatSqaaJsonReportForHook(
      emptyReport({
        files: [
          {
            path: 'src/foo.ts',
            issues: [],
            errors: [{ code: 'FILE_NOT_FOUND', message: 'File not indexed' }],
          },
        ],
      }),
    );

    expect(text).not.toContain('no issues found');
    expect(text).toContain('src/foo.ts');
    expect(text).toContain('FILE_NOT_FOUND');
    expect(text).toContain('File not indexed');
  });

  it('surfaces ignored-only change sets without claiming no issues found', () => {
    const text = formatSqaaJsonReportForHook(
      emptyReport({
        ignored: [{ path: 'image.png', reason: 'binary' }],
      }),
    );

    expect(text).not.toContain('no issues found');
    expect(text).toContain('excluded (binary or oversized)');
    expect(text).toContain('image.png');
    expect(text).toContain('binary');
  });

  it('appends excluded files when analysis completed with no issues', () => {
    const text = formatSqaaJsonReportForHook(
      emptyReport({
        files: [{ path: 'src/a.ts', issues: [], errors: null }],
        ignored: [{ path: 'large.bin', reason: 'oversized' }],
      }),
    );

    expect(text).toContain('No issues found');
    expect(text).toContain('Excluded 1 file(s)');
    expect(text).toContain('large.bin');
    expect(text).toContain('oversized');
  });
});
