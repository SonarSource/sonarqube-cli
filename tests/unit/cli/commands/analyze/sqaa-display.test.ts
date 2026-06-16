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

import { afterEach, describe, expect, it } from 'bun:test';

import type { FileResult, RunTally } from '../../../../../src/cli/commands/analyze/sqaa-analysis';
import {
  computeRunSummaryStats,
  formatSqaaIssueLinePlain,
  formatSqaaPathPlain,
  formatSqaaRunSummaryPlain,
  printSqaaTextReport,
  SQAA_COLLAPSE_CLEAN_THRESHOLD,
} from '../../../../../src/cli/commands/analyze/sqaa-display';
import type { SqaaIssue } from '../../../../../src/sonarqube/client';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../src/ui';

const ANSI_ESCAPE_CODES = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_ESCAPE_CODES, '');
}

function getMockTextLines(): string[] {
  return getMockUiCalls()
    .filter((c) => c.method === 'text')
    .map((c) => stripAnsi(String(c.args[0])));
}

const SAMPLE_ISSUE: SqaaIssue = {
  id: '1',
  message: 'Remove redundant jump',
  rule: 'typescript:S3626',
  textRange: { startLine: 190, endLine: 190, startOffset: 0, endOffset: 0 },
};

function success(path: string, issues: SqaaIssue[] = []): FileResult {
  return { file: path, filePath: path, issues, errors: null };
}

function failure(path: string, message: string): FileResult {
  return { file: path, filePath: path, failure: new Error(message) };
}

describe('formatSqaaPathPlain', () => {
  it('keeps bare filenames unchanged', () => {
    expect(formatSqaaPathPlain('foo.ts')).toBe('foo.ts');
  });

  it('preserves directory prefix', () => {
    expect(formatSqaaPathPlain('src/cli/foo.ts')).toBe('src/cli/foo.ts');
  });
});

describe('formatSqaaIssueLinePlain', () => {
  it('puts line number before message and rule', () => {
    expect(formatSqaaIssueLinePlain(SAMPLE_ISSUE, 1)).toBe(
      '     [1] line 190  Remove redundant jump  typescript:S3626',
    );
  });
});

describe('formatSqaaRunSummaryPlain', () => {
  it('formats clean success summary', () => {
    expect(
      formatSqaaRunSummaryPlain({
        filesAnalyzed: 7,
        filesWithIssues: 0,
        filesWithErrors: 0,
        totalIssues: 0,
        totalFailures: 0,
        totalErrors: 0,
      }),
    ).toBe('✓  No issues found · 7 files analyzed');
  });

  it('formats issues summary', () => {
    expect(
      formatSqaaRunSummaryPlain({
        filesAnalyzed: 14,
        filesWithIssues: 7,
        filesWithErrors: 0,
        totalIssues: 56,
        totalFailures: 0,
        totalErrors: 0,
      }),
    ).toBe('14 files analyzed · 7 with issues · 56 issues found');
  });
});

describe('printSqaaTextReport', () => {
  afterEach(() => {
    setMockUi(false);
    process.exitCode = 0;
  });

  it('renders clean and finding files inline with summary footer', () => {
    setMockUi(true);
    clearMockUiCalls();

    const tally: RunTally = {
      allResults: [success('src/a.ts'), success('src/b.ts', [SAMPLE_ISSUE])],
      totalIssues: 1,
      totalErrors: 0,
      totalFailures: 0,
    };

    printSqaaTextReport({ tally, allPaths: ['src/a.ts', 'src/b.ts'] });

    const texts = getMockTextLines();

    expect(texts.some((l) => l.includes('src/a.ts'))).toBe(true);
    expect(texts.some((l) => l.includes('src/b.ts') && l.includes('1 issue'))).toBe(true);
    expect(texts.some((l) => l.includes('line 190'))).toBe(true);
    expect(texts.some((l) => l.includes('typescript:S3626'))).toBe(true);
    expect(texts.at(-1)).toContain('2 files analyzed · 1 with issues · 1 issue found');
  });

  it('collapses clean files when count exceeds threshold', () => {
    setMockUi(true);
    clearMockUiCalls();

    const cleanPaths = Array.from(
      { length: SQAA_COLLAPSE_CLEAN_THRESHOLD },
      (_, i) => `src/clean-${i}.ts`,
    );
    const findingPath = 'src/hot.ts';
    const allPaths = [...cleanPaths, findingPath];

    const tally: RunTally = {
      allResults: [...cleanPaths.map((p) => success(p)), success(findingPath, [SAMPLE_ISSUE])],
      totalIssues: 1,
      totalErrors: 0,
      totalFailures: 0,
    };

    printSqaaTextReport({ tally, allPaths });

    const texts = getMockTextLines();

    expect(
      texts.some(
        (l) => l.includes(`${SQAA_COLLAPSE_CLEAN_THRESHOLD} files`) && l.includes('no issues'),
      ),
    ).toBe(true);
    expect(texts.filter((l) => l.includes('clean-0.ts'))).toHaveLength(0);
    expect(texts.some((l) => l.includes('src/hot.ts'))).toBe(true);
  });

  it('renders failed and skipped files', () => {
    setMockUi(true);
    clearMockUiCalls();

    const tally: RunTally = {
      allResults: [success('src/a.ts'), failure('src/b.ts', 'network error')],
      totalIssues: 0,
      totalErrors: 0,
      totalFailures: 1,
    };

    printSqaaTextReport({ tally, allPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });

    const texts = getMockTextLines();

    expect(texts.some((l) => l.includes('src/b.ts'))).toBe(true);
    expect(texts.some((l) => l.includes('network error'))).toBe(true);
    expect(texts.some((l) => l.includes('[SKIPPED]') && l.includes('src/c.ts'))).toBe(true);
    expect(texts.at(-1)).toContain('1 failure');
  });
});

describe('computeRunSummaryStats', () => {
  it('counts files with API errors separately from issues', () => {
    const tally: RunTally = {
      allResults: [
        {
          file: 'src/a.ts',
          filePath: 'src/a.ts',
          issues: [],
          errors: [{ code: 'E', message: 'boom' }],
        },
      ],
      totalIssues: 0,
      totalErrors: 1,
      totalFailures: 0,
    };

    const stats = computeRunSummaryStats(tally, ['src/a.ts']);
    expect(stats.filesWithIssues).toBe(0);
    expect(stats.filesWithErrors).toBe(1);
  });

  it('formats errors-only summary without implying issues', () => {
    expect(
      formatSqaaRunSummaryPlain({
        filesAnalyzed: 3,
        filesWithIssues: 0,
        filesWithErrors: 1,
        totalIssues: 0,
        totalFailures: 0,
        totalErrors: 2,
      }),
    ).toBe('3 files analyzed · 1 with errors · 2 errors');
  });
});
