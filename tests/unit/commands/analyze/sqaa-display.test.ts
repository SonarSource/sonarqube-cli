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

import { CommandFailedError } from '@/core/command-error.ts';
import type { SqaaIssue } from '@/core/server/client.ts';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';

import type { FileResult, RunTally } from '../../../../src/commands/analyze/sqaa-analysis.ts';
import {
  computeRunSummaryStats,
  formatSqaaIssueLinePlain,
  formatSqaaPathPlain,
  formatSqaaRunSummaryPlain,
  printSqaaTextReport,
  renderFailureDetailLines,
  SQAA_COLLAPSE_CLEAN_THRESHOLD,
} from '../../../../src/commands/analyze/sqaa-display.ts';

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
        analysisDepth: 'STANDARD',
        hasGlobalError: false,
      }),
    ).toBe('✓ No issues found · 7 files analyzed · STANDARD analysis');
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
        analysisDepth: 'DEEP',
        hasGlobalError: false,
      }),
    ).toBe('14 files analyzed · 7 with issues · 56 issues found · DEEP analysis');
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

    printSqaaTextReport({ tally, allPaths: ['src/a.ts', 'src/b.ts'], analysisDepth: 'STANDARD' });

    const texts = getMockTextLines();

    expect(texts.some((l) => l.includes('src/a.ts'))).toBe(true);
    expect(texts.some((l) => l.includes('src/b.ts') && l.includes('1 issue'))).toBe(true);
    expect(texts.some((l) => l.includes('line 190'))).toBe(true);
    expect(texts.some((l) => l.includes('typescript:S3626'))).toBe(true);
    expect(texts.at(-1)).toContain(
      '2 files analyzed · 1 with issues · 1 issue found · STANDARD analysis',
    );
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

    printSqaaTextReport({ tally, allPaths, analysisDepth: 'DEEP' });

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

    printSqaaTextReport({
      tally,
      allPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      analysisDepth: 'STANDARD',
    });

    const texts = getMockTextLines();

    expect(texts.some((l) => l.includes('src/b.ts'))).toBe(true);
    expect(texts.some((l) => l.includes('network error'))).toBe(true);
    expect(texts.some((l) => l.includes('[SKIPPED]') && l.includes('src/c.ts'))).toBe(true);
    expect(texts.at(-1)).toContain('1 failure · STANDARD analysis');
  });

  it('renders per-file failure detail and remediation hint without redundant heading', () => {
    setMockUi(true);
    clearMockUiCalls();

    const tally: RunTally = {
      allResults: [
        {
          file: 'b.ts',
          filePath: 'b.ts',
          failure: new CommandFailedError("File path must use forward slashes: 'b\\.ts'", {
            remediationHint: "Normalize paths to POSIX form (e.g. 'src/index.ts').",
          }),
        },
      ],
      totalIssues: 0,
      totalErrors: 0,
      totalFailures: 1,
    };

    printSqaaTextReport({ tally, allPaths: ['b.ts'], analysisDepth: 'STANDARD' });

    const texts = getMockTextLines();
    expect(texts.some((l) => l.includes('Vortex analysis failed'))).toBe(false);
    expect(texts.some((l) => l.includes("File path must use forward slashes: 'b\\.ts'"))).toBe(
      true,
    );
    expect(texts.some((l) => l.includes('→ Normalize paths to POSIX form'))).toBe(true);
  });

  it('renders all failed files with a failures-only summary', () => {
    setMockUi(true);
    clearMockUiCalls();

    const validationError = new CommandFailedError(
      'Vortex analysis failed. File path must use forward slashes.',
      { remediationHint: "Normalize paths to POSIX form (e.g. 'src/index.ts')." },
    );
    const tally: RunTally = {
      allResults: [
        { file: '/repo/a.ts', filePath: 'a.ts', failure: validationError },
        { file: '/repo/b.ts', filePath: 'b.ts', failure: validationError },
      ],
      totalIssues: 0,
      totalErrors: 0,
      totalFailures: 2,
    };

    printSqaaTextReport({ tally, allPaths: ['a.ts', 'b.ts'], analysisDepth: 'STANDARD' });

    const texts = getMockTextLines();
    expect(texts.filter((l) => l.includes('a.ts') || l.includes('b.ts'))).toHaveLength(2);
    expect(texts.some((l) => l.includes('forward slashes'))).toBe(true);
    expect(texts.at(-1)).toBe('2 files analyzed · 2 failures · STANDARD analysis');
  });
});

describe('renderFailureDetailLines', () => {
  it('strips heading prefix from a single-line message', () => {
    const lines = renderFailureDetailLines(
      new CommandFailedError('Vortex analysis failed. network error'),
      false,
    );
    expect(lines).toEqual(['     network error']);
  });

  it('strips legacy multiline heading and indents each detail line', () => {
    const lines = renderFailureDetailLines(
      new CommandFailedError('Vortex analysis failed.\n  network error'),
      false,
    );
    expect(lines).toEqual(['     network error']);
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

    const stats = computeRunSummaryStats(tally, ['src/a.ts'], 'STANDARD');
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
        analysisDepth: 'STANDARD',
        hasGlobalError: false,
      }),
    ).toBe('3 files analyzed · 1 with errors · 2 errors · STANDARD analysis');
  });

  it('includes failures and issues in the same summary', () => {
    expect(
      formatSqaaRunSummaryPlain({
        filesAnalyzed: 5,
        filesWithIssues: 2,
        filesWithErrors: 0,
        totalIssues: 2,
        totalFailures: 1,
        totalErrors: 0,
        analysisDepth: 'DEEP',
        hasGlobalError: false,
      }),
    ).toBe('5 files analyzed · 1 failure · 2 with issues · 2 issues found · DEEP analysis');
  });

  it('summarizes when every analyzed file failed', () => {
    expect(
      formatSqaaRunSummaryPlain({
        filesAnalyzed: 2,
        filesWithIssues: 0,
        filesWithErrors: 0,
        totalIssues: 0,
        totalFailures: 2,
        totalErrors: 0,
        analysisDepth: 'STANDARD',
        hasGlobalError: false,
      }),
    ).toBe('2 files analyzed · 2 failures · STANDARD analysis');
  });
});
