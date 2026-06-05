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
import type { SqaaJsonReport } from '../analyze/sqaa-display';

export function formatSqaaIssuesForHook(
  issues: SqaaIssue[],
  errors?: Array<{ code: string; message: string }> | null,
): string {
  const lines: string[] = [];

  if (issues.length === 0) {
    lines.push('Agentic Analysis completed — no issues found.');
  } else {
    lines.push(`Agentic Analysis found ${issues.length} issue${issues.length === 1 ? '' : 's'}:`);
    issues.forEach((issue, idx) => {
      const location = issue.textRange ? ` (line ${issue.textRange.startLine})` : '';
      lines.push(`  [${idx + 1}] ${issue.message}${location} [${issue.rule}]`);
    });
  }

  if (errors && errors.length > 0) {
    lines.push('Agentic Analysis errors:');
    errors.forEach((e) => lines.push(`  [${e.code}] ${e.message}`));
  }

  return lines.join('\n');
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

  const lines: string[] = [];
  const totalIssues = report.summary.totalIssues;
  const hasFileErrors = report.files.some((f) => (f.errors?.length ?? 0) > 0);
  const hasAnalyzedContent = totalIssues > 0 || report.failures.length > 0 || hasFileErrors;

  if (!hasAnalyzedContent) {
    if (report.skipped.length > 0) {
      lines.push(`Skipped ${report.skipped.length} file(s) (analysis not completed).`);
    } else if (report.ignored.length > 0 && report.files.length === 0) {
      lines.push(
        'Agentic Analysis: no files to analyze — all change set files were excluded (binary or oversized).',
      );
    } else {
      lines.push('Agentic Analysis completed — no issues found.');
    }
    appendIgnoredLines(lines, report.ignored);
    return lines.join('\n');
  }

  if (totalIssues > 0) {
    lines.push(`Agentic Analysis found ${totalIssues} issue${totalIssues === 1 ? '' : 's'}:`);
  }

  let issueIndex = 0;
  for (const file of report.files) {
    if (file.issues.length === 0 && !(file.errors && file.errors.length > 0)) {
      continue;
    }
    lines.push(`── ${file.path}`);
    for (const issue of file.issues) {
      issueIndex += 1;
      const location = issue.textRange ? ` (line ${issue.textRange.startLine})` : '';
      lines.push(`  [${issueIndex}] ${issue.message}${location} [${issue.rule}]`);
    }
    if (file.errors && file.errors.length > 0) {
      lines.push('  Analysis errors:');
      file.errors.forEach((e) => lines.push(`  [${e.code}] ${e.message}`));
    }
  }

  if (report.failures.length > 0) {
    lines.push('Agentic Analysis failures:');
    report.failures.forEach((f) => lines.push(`  ${f.path}: ${f.message}`));
  }

  if (report.skipped.length > 0) {
    lines.push(`Skipped ${report.skipped.length} file(s) (analysis not completed).`);
  }

  appendIgnoredLines(lines, report.ignored);

  return lines.join('\n');
}

export function writePostToolUseHookOutput(additionalContext: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
    }) + '\n',
  );
}
