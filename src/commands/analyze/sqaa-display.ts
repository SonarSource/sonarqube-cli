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

// Display layer for SQAA results: text and JSON output.

import { basename, dirname } from 'node:path';

import type { SqaaAnalysisDepth, SqaaIssue } from '../../sonarqube/client.ts';
import { text } from '../../ui';
import { bold, dim, green, red, softBlue, yellow } from '../../ui/colors.ts';
import { CliError } from '../_common/error.ts';
import type { FileResult, FileSuccess, RunTally } from './sqaa-analysis.ts';
import { SQAA_FAILURE_HEADING } from './sqaa-errors.ts';

/** When analyzed file count exceeds this, clean files collapse to one summary row. */
export const SQAA_COLLAPSE_CLEAN_THRESHOLD = 20;

/** Exit code when analysis succeeds and issues are found. */
export const EXIT_CODE_ISSUES_FOUND = 51;

const ISSUE_LINE_INDENT = '     ';

function stripSqaaFailureHeading(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed === SQAA_FAILURE_HEADING) {
    return null;
  }
  const headingPrefix = `${SQAA_FAILURE_HEADING} `;
  if (trimmed.startsWith(headingPrefix)) {
    return trimmed.slice(headingPrefix.length);
  }
  return trimmed;
}

function failureDetailLines(message: string): string[] {
  return message
    .split('\n')
    .map((line) => stripSqaaFailureHeading(line))
    .filter((line): line is string => line != null && line.length > 0);
}

/** Indented detail + optional remediation hint for a failed file row. */
export function renderFailureDetailLines(error: Error, colored: boolean): string[] {
  const lines: string[] = [];
  for (const detail of failureDetailLines(error.message)) {
    const line = `${ISSUE_LINE_INDENT}${detail}`;
    lines.push(colored ? dim(line) : line);
  }
  const hint = error instanceof CliError ? error.remediationHint : undefined;
  if (hint) {
    const line = `${ISSUE_LINE_INDENT}→ ${hint}`;
    lines.push(colored ? dim(line) : line);
  }
  return lines;
}

export interface SqaaRunSummaryStats {
  filesAnalyzed: number;
  filesWithIssues: number;
  filesWithErrors: number;
  totalIssues: number;
  totalFailures: number;
  totalErrors: number;
  analysisDepth: SqaaAnalysisDepth;
}

export interface PrintSqaaTextReportOptions {
  tally: RunTally;
  allPaths: string[];
  ignoredPaths?: string[];
  analysisDepth: SqaaAnalysisDepth;
}

type PathParts = { dir: string; base: string };

function splitSqaaPath(path: string): PathParts {
  const base = basename(path);
  const dir = dirname(path);
  if (dir === '.' || dir === '') {
    return { dir: '', base };
  }
  const normalized = dir.endsWith('/') ? dir : `${dir}/`;
  return { dir: normalized, base };
}

/** Plain-text path: `dir/` + filename (no ANSI). */
export function formatSqaaPathPlain(path: string): string {
  const { dir, base } = splitSqaaPath(path);
  return `${dir}${base}`;
}

/** Colored path: dim directory + bold filename. */
export function formatSqaaPathColored(path: string): string {
  const { dir, base } = splitSqaaPath(path);
  if (!dir) {
    return bold(base);
  }
  return `${dim(dir)}${bold(base)}`;
}

function formatIssueCountTag(issueCount: number, errorCount: number, colored: boolean): string {
  const parts: string[] = [];
  if (issueCount > 0) {
    parts.push(`${issueCount} issue${issueCount === 1 ? '' : 's'}`);
  }
  if (errorCount > 0) {
    parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) {
    return '';
  }
  const tag = ` · ${parts.join(', ')}`;
  return colored ? yellow(tag) : tag;
}

/** Plain issue/error count suffix for hook and text output. */
export function formatIssueCountTagPlain(issueCount: number, errorCount: number): string {
  return formatIssueCountTag(issueCount, errorCount, false);
}

/** IDE-style issue line (plain text). */
export function formatSqaaIssueLinePlain(issue: SqaaIssue, index: number): string {
  const idx = `[${index}]`;
  const { message, rule, textRange } = issue;
  const linePart = textRange ? `line ${textRange.startLine}` : '';
  if (linePart) {
    return `${ISSUE_LINE_INDENT}${idx} ${linePart}  ${message}  ${rule}`;
  }
  return `${ISSUE_LINE_INDENT}${idx} ${message}  ${rule}`;
}

/** IDE-style issue line with ANSI colors. */
export function formatSqaaIssueLineColored(issue: SqaaIssue, index: number): string {
  const idx = dim(`[${index}]`);
  const { message, rule, textRange } = issue;
  if (textRange) {
    const lineLabel = dim('line');
    const lineNum = softBlue(String(textRange.startLine));
    return `${ISSUE_LINE_INDENT}${idx} ${lineLabel} ${lineNum}  ${message}  ${dim(rule)}`;
  }
  return `${ISSUE_LINE_INDENT}${idx} ${message}  ${dim(rule)}`;
}

function formatSqaaErrorLine(err: { code: string; message: string }, colored: boolean): string {
  const line = `${ISSUE_LINE_INDENT}[${err.code}] ${err.message}`;
  return colored ? dim(line) : line;
}

/** Plain analysis error line for hook and text output. */
export function formatSqaaErrorLinePlain(err: { code: string; message: string }): string {
  return formatSqaaErrorLine(err, false);
}

function formatCleanCollapsedRow(count: number, colored: boolean): string {
  const icon = colored ? green('✓') : '✓';
  const countLabel = colored ? bold(String(count)) : String(count);
  const suffix = colored ? dim(' — no issues') : ' — no issues';
  return `  ${icon}  ${countLabel} files${suffix}`;
}

function formatCleanFileRow(path: string, colored: boolean): string {
  const icon = colored ? green('✓') : '✓';
  const pathLabel = colored ? formatSqaaPathColored(path) : formatSqaaPathPlain(path);
  return `  ${icon}  ${pathLabel}`;
}

function formatFindingsFileRow(
  path: string,
  issueCount: number,
  errorCount: number,
  colored: boolean,
): string {
  const icon = colored ? yellow('!') : '!';
  const pathLabel = colored ? formatSqaaPathColored(path) : formatSqaaPathPlain(path);
  const tag = formatIssueCountTag(issueCount, errorCount, colored);
  return `  ${icon}  ${pathLabel}${tag}`;
}

function formatFailedFileRow(path: string, colored: boolean): string {
  const icon = colored ? red('✗') : '✗';
  const pathLabel = colored ? formatSqaaPathColored(path) : formatSqaaPathPlain(path);
  return `  ${icon}  ${pathLabel}`;
}

function formatSkippedOrIgnoredRow(
  path: string,
  label: '[SKIPPED]' | '[IGNORED]',
  colored: boolean,
): string {
  const icon = colored ? dim('⊘') : '⊘';
  const pathLabel = colored ? formatSqaaPathColored(path) : formatSqaaPathPlain(path);
  const status = colored ? dim(label) : label;
  return `  ${icon}  ${pathLabel}  ${status}`;
}

export function sqaaFileHasFindings(
  issues: SqaaIssue[],
  errors?: Array<{ code: string; message: string }> | null,
): boolean {
  return issues.length > 0 || (errors?.length ?? 0) > 0;
}

function fileHasFindings(result: FileSuccess): boolean {
  return sqaaFileHasFindings(result.issues, result.errors);
}

function buildResultMap(results: FileResult[]): Map<string, FileResult> {
  return new Map(results.map((r) => [r.filePath, r]));
}

export function computeRunSummaryStats(
  tally: RunTally,
  allPaths: string[],
  analysisDepth: SqaaAnalysisDepth,
): SqaaRunSummaryStats {
  let filesWithIssues = 0;
  let filesWithErrors = 0;
  for (const result of tally.allResults) {
    if ('failure' in result) continue;
    if (result.issues.length > 0) {
      filesWithIssues += 1;
    }
    if ((result.errors?.length ?? 0) > 0) {
      filesWithErrors += 1;
    }
  }
  return {
    filesAnalyzed: allPaths.length,
    filesWithIssues,
    filesWithErrors,
    totalIssues: tally.totalIssues,
    totalFailures: tally.totalFailures,
    totalErrors: tally.totalErrors,
    analysisDepth,
  };
}

function formatAnalysisDepthSuffix(depth: SqaaAnalysisDepth, colored: boolean): string {
  const label = ` · ${depth} analysis`;
  return colored ? dim(label) : label;
}

function formatSqaaRunSummary(stats: SqaaRunSummaryStats, colored: boolean): string {
  const num = (n: number) => (colored ? yellow(String(n)) : String(n));
  const failNum = (n: number) => (colored ? red(String(n)) : String(n));
  const lbl = (s: string) => (colored ? bold(s) : s);
  const okIcon = colored ? green('✓') : '✓';

  const hasFailures = stats.totalFailures > 0;
  const hasIssues = stats.totalIssues > 0;
  const hasErrors = stats.totalErrors > 0;

  if (!hasFailures && !hasIssues && !hasErrors) {
    return `${okIcon} ${lbl('No issues found')} · ${num(stats.filesAnalyzed)} ${lbl('files analyzed')}${formatAnalysisDepthSuffix(stats.analysisDepth, colored)}`;
  }

  const parts: string[] = [`${num(stats.filesAnalyzed)} ${lbl('files analyzed')}`];

  if (hasFailures) {
    const failureWord = stats.totalFailures === 1 ? 'failure' : 'failures';
    parts.push(`${failNum(stats.totalFailures)} ${lbl(failureWord)}`);
  }
  if (hasIssues) {
    const issueWord = stats.totalIssues === 1 ? 'issue' : 'issues';
    parts.push(
      `${num(stats.filesWithIssues)} ${lbl('with issues')}`,
      `${num(stats.totalIssues)} ${lbl(issueWord)} found`,
    );
  }
  if (hasErrors) {
    const errorWord = stats.totalErrors === 1 ? 'error' : 'errors';
    parts.push(
      `${num(stats.filesWithErrors)} ${lbl('with errors')}`,
      `${num(stats.totalErrors)} ${lbl(errorWord)}`,
    );
  }

  return `${parts.join(' · ')}${formatAnalysisDepthSuffix(stats.analysisDepth, colored)}`;
}

/** Plain-text run summary footer. */
export function formatSqaaRunSummaryPlain(stats: SqaaRunSummaryStats): string {
  return formatSqaaRunSummary(stats, false);
}

/** Colored run summary footer. */
export function formatSqaaRunSummaryColored(stats: SqaaRunSummaryStats): string {
  return formatSqaaRunSummary(stats, true);
}

function appendFileFindingsLines(lines: string[], result: FileSuccess, colored: boolean): void {
  result.issues.forEach((issue, idx) => {
    lines.push(
      colored
        ? formatSqaaIssueLineColored(issue, idx + 1)
        : formatSqaaIssueLinePlain(issue, idx + 1),
    );
  });
  if (result.errors) {
    for (const err of result.errors) {
      lines.push(formatSqaaErrorLine(err, colored));
    }
  }
}

/** Plain-text lines for one analyzed file (row + inline issues/errors). */
export function renderPlainAnalyzedFileLines(
  path: string,
  issues: SqaaIssue[],
  errors?: Array<{ code: string; message: string }> | null,
): string[] {
  return renderFileEntryLines(path, { file: path, filePath: path, issues, errors }, false);
}

/** Plain-text collapsed clean-files summary row. */
export function formatPlainCleanCollapsedRow(count: number): string {
  return formatCleanCollapsedRow(count, false);
}

/** Plain-text skipped or ignored file row. */
export function formatPlainSkippedOrIgnoredRow(
  path: string,
  label: '[SKIPPED]' | '[IGNORED]',
): string {
  return formatSkippedOrIgnoredRow(path, label, false);
}

function renderFileEntryLines(
  path: string,
  result: FileResult | undefined,
  colored: boolean,
): string[] {
  const lines: string[] = [];

  if (!result) {
    lines.push(formatSkippedOrIgnoredRow(path, '[SKIPPED]', colored));
    return lines;
  }

  if ('failure' in result) {
    return [
      formatFailedFileRow(path, colored),
      ...renderFailureDetailLines(result.failure, colored),
    ];
  }

  if (fileHasFindings(result)) {
    lines.push(
      formatFindingsFileRow(path, result.issues.length, result.errors?.length ?? 0, colored),
    );
    appendFileFindingsLines(lines, result, colored);
    return lines;
  }

  lines.push(formatCleanFileRow(path, colored));
  return lines;
}

type ChangeSetPathBuckets = {
  cleanCount: number;
  findingPaths: string[];
  failedPaths: string[];
  skippedPaths: string[];
};

function classifyChangeSetPaths(
  allPaths: string[],
  resultMap: Map<string, FileResult>,
): ChangeSetPathBuckets {
  let cleanCount = 0;
  const findingPaths: string[] = [];
  const failedPaths: string[] = [];
  const skippedPaths: string[] = [];

  for (const path of allPaths) {
    const result = resultMap.get(path);
    if (!result) {
      skippedPaths.push(path);
      continue;
    }
    if ('failure' in result) {
      failedPaths.push(path);
      continue;
    }
    if (fileHasFindings(result)) {
      findingPaths.push(path);
      continue;
    }
    cleanCount += 1;
  }

  return { cleanCount, findingPaths, failedPaths, skippedPaths };
}

function renderCollapsedChangeSetLines(
  buckets: ChangeSetPathBuckets,
  resultMap: Map<string, FileResult>,
  colored: boolean,
): string[] {
  const lines: string[] = [];
  if (buckets.cleanCount > 0) {
    lines.push(formatCleanCollapsedRow(buckets.cleanCount, colored));
  }
  for (const path of buckets.findingPaths) {
    lines.push(...renderFileEntryLines(path, resultMap.get(path), colored));
  }
  for (const path of buckets.failedPaths) {
    lines.push(...renderFileEntryLines(path, resultMap.get(path), colored));
  }
  for (const path of buckets.skippedPaths) {
    lines.push(formatSkippedOrIgnoredRow(path, '[SKIPPED]', colored));
  }
  return lines;
}

function renderChangeSetReportLines(
  tally: RunTally,
  allPaths: string[],
  ignoredPaths: string[],
  colored: boolean,
): string[] {
  const resultMap = buildResultMap(tally.allResults);
  const collapseClean = allPaths.length > SQAA_COLLAPSE_CLEAN_THRESHOLD;

  const bodyLines = collapseClean
    ? renderCollapsedChangeSetLines(classifyChangeSetPaths(allPaths, resultMap), resultMap, colored)
    : allPaths.flatMap((path) => renderFileEntryLines(path, resultMap.get(path), colored));

  const ignoredLines = ignoredPaths.map((path) =>
    formatSkippedOrIgnoredRow(path, '[IGNORED]', colored),
  );

  return [...bodyLines, ...ignoredLines];
}

/** Unified change-set text report (file rows, inline issues, summary footer). */
export function printSqaaTextReport(options: PrintSqaaTextReportOptions): void {
  const { tally, allPaths, ignoredPaths = [], analysisDepth } = options;
  const stats = computeRunSummaryStats(tally, allPaths, analysisDepth);

  for (const line of renderChangeSetReportLines(tally, allPaths, ignoredPaths, true)) {
    text(line);
  }

  text('');
  text(formatSqaaRunSummaryColored(stats));
  applyExitCode(stats);
}

/** Single `--file` failure: same ✗ row + summary footer as change-set analysis. */
export function printSingleFileTextFailure(
  filePath: string,
  error: Error,
  analysisDepth: SqaaAnalysisDepth = 'STANDARD',
): void {
  const tally: RunTally = {
    allResults: [{ file: filePath, filePath, failure: error }],
    totalIssues: 0,
    totalErrors: 0,
    totalFailures: 1,
  };
  printSqaaTextReport({ tally, allPaths: [filePath], analysisDepth });
}

export function applyExitCode(stats: SqaaRunSummaryStats): void;
export function applyExitCode(totalIssues: number, totalFailures: number): void;
export function applyExitCode(
  statsOrIssues: SqaaRunSummaryStats | number,
  totalFailures = 0,
): void {
  const failures = typeof statsOrIssues === 'number' ? totalFailures : statsOrIssues.totalFailures;
  const issues = typeof statsOrIssues === 'number' ? statsOrIssues : statsOrIssues.totalIssues;

  if (failures > 0) {
    process.exitCode = 1;
  } else if (issues > 0) {
    process.exitCode = EXIT_CODE_ISSUES_FOUND;
  }
}

export function displaySqaaResults(
  issues: SqaaIssue[],
  errors: Array<{ code: string; message: string }> | null | undefined,
  filePath: string,
  analysisDepth: SqaaAnalysisDepth = 'STANDARD',
): number {
  const result: FileSuccess = {
    file: filePath,
    filePath,
    issues,
    errors,
  };

  const lines: string[] = [];
  if (fileHasFindings(result)) {
    lines.push(formatFindingsFileRow(filePath, issues.length, errors?.length ?? 0, true));
    appendFileFindingsLines(lines, result, true);
  } else {
    lines.push(formatCleanFileRow(filePath, true));
  }

  for (const line of lines) {
    text(line);
  }

  const stats: SqaaRunSummaryStats = {
    filesAnalyzed: 1,
    filesWithIssues: issues.length > 0 ? 1 : 0,
    filesWithErrors: (errors?.length ?? 0) > 0 ? 1 : 0,
    totalIssues: issues.length,
    totalFailures: 0,
    totalErrors: errors?.length ?? 0,
    analysisDepth,
  };

  text('');
  text(formatSqaaRunSummaryColored(stats));
  applyExitCode(stats);

  return issues.length;
}

export type { SqaaJsonReport } from './sqaa-display-json.ts';
export {
  buildJsonReport,
  makeReport,
  printJsonReport,
  singleFileFailureReport,
  singleFileSuccessReport,
} from './sqaa-display-json.ts';
