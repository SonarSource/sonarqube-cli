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

// Text formatting for PostToolUse hook additionalContext (Claude + Codex).

import type { SqaaIssue } from '../../../sonarqube/client';
import {
  formatPlainCleanCollapsedRow,
  formatPlainSkippedOrIgnoredRow,
  formatSqaaRunSummaryPlain,
  renderPlainAnalyzedFileLines,
  SQAA_COLLAPSE_CLEAN_THRESHOLD,
  sqaaFileHasFindings,
  type SqaaJsonReport,
  type SqaaRunSummaryStats,
} from '../analyze/sqaa-display';

function hookSummaryFromReport(report: SqaaJsonReport): SqaaRunSummaryStats {
  let filesWithIssues = 0;
  let filesWithErrors = 0;
  let totalErrors = 0;
  for (const file of report.files) {
    totalErrors += file.errors?.length ?? 0;
    if (file.issues.length > 0) {
      filesWithIssues += 1;
    }
    if ((file.errors?.length ?? 0) > 0) {
      filesWithErrors += 1;
    }
  }
  return {
    filesAnalyzed: report.files.length + report.failures.length + report.skipped.length,
    filesWithIssues,
    filesWithErrors,
    totalIssues: report.summary.totalIssues,
    totalFailures: report.summary.totalFailures,
    totalErrors,
    analysisDepth: report.analysisDepth,
  };
}

export function formatSqaaIssuesForHook(
  issues: SqaaIssue[],
  errors: Array<{ code: string; message: string }> | null | undefined,
  filePath: string,
): string {
  const issueCount = issues.length;
  const errorCount = errors?.length ?? 0;

  return [
    ...renderPlainAnalyzedFileLines(filePath, issues, errors),
    '',
    formatSqaaRunSummaryPlain({
      filesAnalyzed: 1,
      filesWithIssues: issueCount > 0 ? 1 : 0,
      filesWithErrors: errorCount > 0 ? 1 : 0,
      totalIssues: issueCount,
      totalFailures: 0,
      totalErrors: errorCount,
      analysisDepth: 'STANDARD',
    }),
  ].join('\n');
}

function appendIgnoredLines(lines: string[], ignored: SqaaJsonReport['ignored']): void {
  if (ignored.length === 0) {
    return;
  }
  lines.push(`Excluded ${ignored.length} file(s) from analysis (binary or oversized):`);
  for (const file of ignored) {
    lines.push(`  ${file.path} (${file.reason})`);
  }
}

function formatNoAnalyzedContent(report: SqaaJsonReport): string {
  const lines: string[] = [];
  if (report.skipped.length > 0) {
    lines.push(`Skipped ${report.skipped.length} file(s) (analysis not completed).`);
  } else if (report.ignored.length > 0 && report.files.length === 0) {
    lines.push(
      'Agentic Analysis: no files to analyze — all change set files were excluded (binary or oversized).',
    );
  } else {
    lines.push(formatSqaaRunSummaryPlain(hookSummaryFromReport(report)));
  }
  appendIgnoredLines(lines, report.ignored);
  return lines.join('\n');
}

function renderFileList(report: SqaaJsonReport, lines: string[]): void {
  const processableCount = report.files.length + report.failures.length + report.skipped.length;
  const collapseClean = processableCount > SQAA_COLLAPSE_CLEAN_THRESHOLD;

  if (collapseClean) {
    const cleanCount = report.files.filter((f) => !sqaaFileHasFindings(f.issues, f.errors)).length;
    if (cleanCount > 0) {
      lines.push(formatPlainCleanCollapsedRow(cleanCount));
    }
    for (const file of report.files) {
      if (!sqaaFileHasFindings(file.issues, file.errors)) continue;
      lines.push(...renderPlainAnalyzedFileLines(file.path, file.issues, file.errors));
    }
  } else {
    for (const file of report.files) {
      lines.push(...renderPlainAnalyzedFileLines(file.path, file.issues, file.errors));
    }
  }
}

/**
 * Format a change-set SQAA JSON report for hook additionalContext.
 * Returns null when there is nothing useful to surface (empty change set).
 */
export function formatSqaaJsonReportForHook(report: SqaaJsonReport): string | null {
  if (
    report.files.length === 0 &&
    report.ignored.length === 0 &&
    report.failures.length === 0 &&
    report.skipped.length === 0
  ) {
    return null;
  }

  const totalIssues = report.summary.totalIssues;
  const hasFileErrors = report.files.some((f) => (f.errors?.length ?? 0) > 0);
  const hasAnalyzedContent = totalIssues > 0 || report.failures.length > 0 || hasFileErrors;

  if (!hasAnalyzedContent) {
    return formatNoAnalyzedContent(report);
  }

  const lines: string[] = [];
  renderFileList(report, lines);

  if (report.failures.length > 0) {
    lines.push('Agentic Analysis failures:');
    report.failures.forEach((f) => lines.push(`  ✗  ${f.path}: ${f.message}`));
  }

  if (report.skipped.length > 0) {
    for (const path of report.skipped) {
      lines.push(formatPlainSkippedOrIgnoredRow(path, '[SKIPPED]'));
    }
  }

  appendIgnoredLines(lines, report.ignored);
  if (lines.length > 0) {
    lines.push('');
  }
  lines.push(formatSqaaRunSummaryPlain(hookSummaryFromReport(report)));

  return lines.join('\n');
}

export function writePostToolUseHookOutput(additionalContext: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
    }) + '\n',
  );
}
