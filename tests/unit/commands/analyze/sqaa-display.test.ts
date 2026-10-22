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

import type { FileResult, RunTally } from '@/commands/analyze/sqaa-analysis.ts';
import type { SqaaIssue } from '@/commands/analyze/sqaa-wire-types.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';

import {
  buildJsonReport,
  computeRunSummaryStats,
  formatSqaaIssueLinePlain,
  formatSqaaPathPlain,
  formatSqaaRunSummaryPlain,
  printSqaaTextReport,
  renderFailureDetailLines,
  SQAA_COLLAPSE_CLEAN_THRESHOLD,
} from '../../../../src/commands/analyze/sqaa-display.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';

const ANSI_ESCAPE_CODES = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_ESCAPE_CODES, '');
}

function getMockTextLines(fake: FakeConsole): string[] {
  return fake.calls.filter((c) => c.method === 'text').map((c) => stripAnsi(String(c.args[0])));
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
  let fake: FakeConsole;

  beforeEach(() => {
    fake = new FakeConsole();
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it('renders clean and finding files inline with summary footer', () => {
    fake.calls.length = 0;

    const tally: RunTally = {
      allResults: [success('src/a.ts'), success('src/b.ts', [SAMPLE_ISSUE])],
      totalIssues: 1,
      totalErrors: 0,
      totalFailures: 0,
    };

    printSqaaTextReport(
      { tally, allPaths: ['src/a.ts', 'src/b.ts'], analysisDepth: 'STANDARD' },
      fake,
    );

    const texts = getMockTextLines(fake);

    expect(texts.some((l) => l.includes('src/a.ts'))).toBe(true);
    expect(texts.some((l) => l.includes('src/b.ts') && l.includes('1 issue'))).toBe(true);
    expect(texts.some((l) => l.includes('line 190'))).toBe(true);
    expect(texts.some((l) => l.includes('typescript:S3626'))).toBe(true);
    expect(texts.at(-1)).toContain(
      '2 files analyzed · 1 with issues · 1 issue found · STANDARD analysis',
    );
  });

  it('collapses clean files when count exceeds threshold', () => {
    fake.calls.length = 0;

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

    printSqaaTextReport({ tally, allPaths, analysisDepth: 'DEEP' }, fake);

    const texts = getMockTextLines(fake);

    expect(
      texts.some(
        (l) => l.includes(`${SQAA_COLLAPSE_CLEAN_THRESHOLD} files`) && l.includes('no issues'),
      ),
    ).toBe(true);
    expect(texts.filter((l) => l.includes('clean-0.ts'))).toHaveLength(0);
    expect(texts.some((l) => l.includes('src/hot.ts'))).toBe(true);
  });

  it('renders failed and skipped files', () => {
    fake.calls.length = 0;

    const tally: RunTally = {
      allResults: [success('src/a.ts'), failure('src/b.ts', 'network error')],
      totalIssues: 0,
      totalErrors: 0,
      totalFailures: 1,
    };

    printSqaaTextReport(
      {
        tally,
        allPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        analysisDepth: 'STANDARD',
      },
      fake,
    );

    const texts = getMockTextLines(fake);

    expect(texts.some((l) => l.includes('src/b.ts'))).toBe(true);
    expect(texts.some((l) => l.includes('network error'))).toBe(true);
    expect(texts.some((l) => l.includes('[SKIPPED]') && l.includes('src/c.ts'))).toBe(true);
    expect(texts.at(-1)).toContain('1 failure · STANDARD analysis');
  });

  it('renders per-file failure detail and remediation hint without redundant heading', () => {
    fake.calls.length = 0;

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

    printSqaaTextReport({ tally, allPaths: ['b.ts'], analysisDepth: 'STANDARD' }, fake);

    const texts = getMockTextLines(fake);
    expect(texts.some((l) => l.includes('Vortex analysis failed'))).toBe(false);
    expect(texts.some((l) => l.includes("File path must use forward slashes: 'b\\.ts'"))).toBe(
      true,
    );
    expect(texts.some((l) => l.includes('→ Normalize paths to POSIX form'))).toBe(true);
  });

  it('renders all failed files with a failures-only summary', () => {
    fake.calls.length = 0;

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

    printSqaaTextReport({ tally, allPaths: ['a.ts', 'b.ts'], analysisDepth: 'STANDARD' }, fake);

    const texts = getMockTextLines(fake);
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

describe('printSqaaTextReport grouped by project', () => {
  let fake: FakeConsole;

  beforeEach(() => {
    fake = new FakeConsole();
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  const twoProjects = [
    { projectKey: 'app-a', paths: ['packages/a/x.ts', 'packages/a/y.ts'] },
    { projectKey: 'app-b', paths: ['packages/b/z.ts'] },
  ];

  function twoProjectTally(): RunTally {
    return {
      allResults: [
        success('packages/a/x.ts', [SAMPLE_ISSUE, SAMPLE_ISSUE]),
        success('packages/a/y.ts'),
        success('packages/b/z.ts', [SAMPLE_ISSUE]),
      ],
      totalIssues: 3,
      totalErrors: 0,
      totalFailures: 0,
    };
  }

  it('puts each project under a header with its file and issue counts', () => {
    printSqaaTextReport(
      {
        tally: twoProjectTally(),
        allPaths: twoProjects.flatMap((p) => p.paths),
        projects: twoProjects,
        analysisDepth: 'STANDARD',
      },
      fake,
    );

    const texts = getMockTextLines(fake);
    const headerA = texts.indexOf('app-a · 2 files · 2 issues');
    const headerB = texts.indexOf('app-b · 1 file · 1 issue');

    expect(headerA).toBeGreaterThanOrEqual(0);
    expect(headerB).toBeGreaterThan(headerA);
    expect(texts.findIndex((l) => l.includes('packages/a/x.ts'))).toBeGreaterThan(headerA);
    expect(texts.findIndex((l) => l.includes('packages/a/y.ts'))).toBeLessThan(headerB);
    expect(texts.findIndex((l) => l.includes('packages/b/z.ts'))).toBeGreaterThan(headerB);
    expect(texts[headerB - 1]).toBe('');
    expect(texts.at(-1)).toContain('3 files analyzed');
  });

  it('puts ignored rows in their own section after every project', () => {
    printSqaaTextReport(
      {
        tally: twoProjectTally(),
        allPaths: twoProjects.flatMap((p) => p.paths),
        ignoredPaths: ['docs/readme.md'],
        projects: twoProjects,
        analysisDepth: 'STANDARD',
      },
      fake,
    );

    const texts = getMockTextLines(fake);
    const header = texts.indexOf('Not analyzed · 1 file');
    const row = texts.findIndex((l) => l.includes('docs/readme.md'));

    expect(header).toBeGreaterThan(texts.findIndex((l) => l.includes('packages/b/z.ts')));
    expect(texts[header - 1]).toBe('');
    expect(row).toBe(header + 1);
    expect(texts[row]).toContain('[IGNORED]');
  });

  it('adds no ignored section when nothing was ignored', () => {
    printSqaaTextReport(
      {
        tally: twoProjectTally(),
        allPaths: twoProjects.flatMap((p) => p.paths),
        projects: twoProjects,
        analysisDepth: 'STANDARD',
      },
      fake,
    );

    expect(getMockTextLines(fake).some((l) => l.startsWith('Not analyzed'))).toBe(false);
  });

  it('leaves ignored rows without a header when the run covers one project', () => {
    printSqaaTextReport(
      {
        tally: twoProjectTally(),
        allPaths: ['packages/a/x.ts'],
        ignoredPaths: ['docs/readme.md'],
        projects: [{ projectKey: 'app-a', paths: ['packages/a/x.ts'] }],
        analysisDepth: 'STANDARD',
      },
      fake,
    );

    const texts = getMockTextLines(fake);

    expect(texts.some((l) => l.startsWith('Not analyzed'))).toBe(false);
    expect(texts.some((l) => l.includes('docs/readme.md') && l.includes('[IGNORED]'))).toBe(true);
  });

  it('keeps a skipped file under its own project', () => {
    printSqaaTextReport(
      {
        tally: {
          allResults: [success('packages/a/x.ts'), success('packages/a/y.ts')],
          totalIssues: 0,
          totalErrors: 0,
          totalFailures: 0,
        },
        allPaths: twoProjects.flatMap((p) => p.paths),
        projects: twoProjects,
        analysisDepth: 'STANDARD',
      },
      fake,
    );

    const texts = getMockTextLines(fake);

    expect(texts.findIndex((l) => l.includes('packages/b/z.ts') && l.includes('[SKIPPED]'))).toBe(
      texts.indexOf('app-b · 1 file · 0 issues') + 1,
    );
  });

  it('collapses clean files within each project, not across the run', () => {
    const clean = Array.from(
      { length: SQAA_COLLAPSE_CLEAN_THRESHOLD + 1 },
      (_, i) => `packages/a/clean-${i}.ts`,
    );
    const projects = [
      { projectKey: 'app-a', paths: clean },
      { projectKey: 'app-b', paths: ['packages/b/z.ts'] },
    ];

    printSqaaTextReport(
      {
        tally: {
          allResults: [...clean.map((p) => success(p)), success('packages/b/z.ts')],
          totalIssues: 0,
          totalErrors: 0,
          totalFailures: 0,
        },
        allPaths: projects.flatMap((p) => p.paths),
        projects,
        analysisDepth: 'STANDARD',
      },
      fake,
    );

    const texts = getMockTextLines(fake);

    expect(texts.filter((l) => l.includes('clean-0.ts'))).toHaveLength(0);
    expect(texts.some((l) => l.includes('packages/b/z.ts'))).toBe(true);
  });

  it('renders a single project exactly as an ungrouped run', () => {
    const grouped = new FakeConsole();
    const tally = twoProjectTally();
    const allPaths = ['packages/a/x.ts', 'packages/a/y.ts', 'packages/b/z.ts'];

    printSqaaTextReport({ tally, allPaths, analysisDepth: 'STANDARD' }, fake);
    printSqaaTextReport(
      {
        tally,
        allPaths,
        projects: [{ projectKey: 'app-a', paths: allPaths }],
        analysisDepth: 'STANDARD',
      },
      grouped,
    );

    expect(getMockTextLines(grouped)).toEqual(getMockTextLines(fake));
  });
});

describe('buildJsonReport project field', () => {
  const tally: RunTally = {
    allResults: [success('packages/a/x.ts', [SAMPLE_ISSUE]), failure('packages/b/z.ts', 'boom')],
    totalIssues: 1,
    totalErrors: 0,
    totalFailures: 1,
  };
  const allPaths = ['packages/a/x.ts', 'packages/b/z.ts'];

  it('tags files and failures with the project they were analyzed against', () => {
    const report = buildJsonReport(tally, [], allPaths, undefined, 'STANDARD', [
      { projectKey: 'app-a', paths: ['packages/a/x.ts'] },
      { projectKey: 'app-b', paths: ['packages/b/z.ts'] },
    ]);

    expect(report.files.map((f) => f.project)).toEqual(['app-a']);
    expect(report.failures.map((f) => f.project)).toEqual(['app-b']);
    expect(report.summary).toEqual({ totalIssues: 1, totalFailures: 1, totalSkipped: 0 });
  });

  it('tags a single-project run too, so the shape does not depend on the project count', () => {
    const report = buildJsonReport(tally, [], allPaths, undefined, 'STANDARD', [
      { projectKey: 'app-a', paths: allPaths },
    ]);

    expect(report.files[0].project).toBe('app-a');
    expect(report.failures[0].project).toBe('app-a');
  });

  it('leaves the field out when no projects are given', () => {
    const report = buildJsonReport(tally, [], allPaths);

    expect('project' in report.files[0]).toBe(false);
    expect('project' in report.failures[0]).toBe(false);
  });
});
