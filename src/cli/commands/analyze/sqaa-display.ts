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

import type { SqaaIssue } from '../../../sonarqube/client';
import { blank, error, print, success, text } from '../../../ui';
import type { FileFailure, FileResult, FileSuccess, RunTally } from './sqaa-analysis';
import { toRelativePosixPath } from './sqaa-api';
import type { IgnoredFile } from './sqaa-changeset';

/** Exit code when analysis succeeds and issues are found. */
export const EXIT_CODE_ISSUES_FOUND = 51;

export interface SqaaJsonReport {
  files: Array<{
    path: string;
    issues: SqaaIssue[];
    errors?: Array<{ code: string; message: string }> | null;
  }>;
  ignored: Array<{ path: string; reason: 'binary' | 'oversized' }>;
  failures: Array<{ path: string; message: string }>;
  /** Files in the change set that were never sent to the API (fail-fast skipped them). */
  skipped: string[];
  summary: { totalIssues: number; totalFailures: number; totalSkipped: number };
}

export function printJsonReport(
  tally: RunTally,
  ignored: IgnoredFile[],
  allPaths: string[],
  pathBase?: string,
): void {
  const files = tally.allResults
    .filter((r): r is FileSuccess => !('failure' in r))
    .map((r) => ({ path: r.filePath, issues: r.issues, errors: r.errors }));

  const failures = tally.allResults
    .filter((r): r is FileFailure => 'failure' in r)
    .map((r) => ({ path: r.filePath, message: r.failure.message }));

  const processedPaths = new Set<string>(tally.allResults.map((r) => r.filePath));
  const skipped = allPaths.filter((p) => !processedPaths.has(p));

  const report: SqaaJsonReport = {
    files,
    ignored: ignored.map((f) => ({
      path: toRelativePosixPath(f.path, pathBase),
      reason: f.reason,
    })),
    failures,
    skipped,
    summary: {
      totalIssues: tally.totalIssues,
      totalFailures: tally.totalFailures,
      totalSkipped: skipped.length,
    },
  };

  print(JSON.stringify(report, null, 2));
}

export function applyExitCode(totalIssues: number, totalFailures: number): void {
  if (totalFailures > 0) {
    process.exitCode = 1;
  } else if (totalIssues > 0) {
    process.exitCode = EXIT_CODE_ISSUES_FOUND;
  }
}

export function printFileDetails(allResults: FileResult[]): void {
  blank();
  for (const result of allResults) {
    if ('failure' in result) {
      text(`── ${result.filePath}`);
      text(`   Failed to analyze: ${result.failure.message}`);
      blank();
    } else if (result.issues.length > 0 || (result.errors && result.errors.length > 0)) {
      text(`── ${result.filePath}`);
      printIssuesAndErrors(result.issues, result.errors);
    }
  }
}

export function printIssuesAndErrors(
  issues: SqaaIssue[],
  errors?: Array<{ code: string; message: string }> | null,
): void {
  if (issues.length > 0) {
    text(`   Found ${issues.length} issue${issues.length === 1 ? '' : 's'}:`);
    blank();
    issues.forEach((issue, idx) => {
      const location = issue.textRange ? ` (line ${issue.textRange.startLine})` : '';
      text(`  [${idx + 1}] ${issue.message}${location}`);
      text(`      Rule: ${issue.rule}`);
    });
    blank();
  }
  if (errors && errors.length > 0) {
    text('   Analysis errors:');
    errors.forEach((e) => {
      text(`  [${e.code}] ${e.message}`);
    });
    blank();
  }
}

export function printSummary(
  totalIssues: number,
  totalErrors: number,
  totalFailures: number,
): void {
  if (totalFailures > 0) {
    // Failures take precedence: the run was incomplete regardless of issues found so far.
    error(
      `SonarQube Agentic Analysis completed with ${totalFailures} failure${totalFailures === 1 ? '' : 's'}.`,
    );
    process.exitCode = 1;
  } else if (totalIssues > 0) {
    process.exitCode = EXIT_CODE_ISSUES_FOUND;
  } else if (totalErrors === 0) {
    success('SonarQube Agentic Analysis completed — change set is clean.');
  }
  // else: no issues, no failures, but API-level errors were printed per file — stay silent on the
  // summary line (matches single-file behavior) and leave the exit code untouched.
}

export function displaySqaaResults(
  issues: SqaaIssue[],
  errors?: Array<{ code: string; message: string }> | null,
  inChangeSetMode = false,
): number {
  blank();

  if (issues.length === 0) {
    if (!inChangeSetMode) {
      success('SonarQube Agentic Analysis completed — no issues found.');
    }
  } else {
    error(
      `SonarQube Agentic Analysis found ${issues.length} issue${issues.length === 1 ? '' : 's'}:`,
    );
    blank();
    issues.forEach((issue, idx) => {
      const location = issue.textRange ? ` (line ${issue.textRange.startLine})` : '';
      text(`  [${idx + 1}] ${issue.message}${location}`);
      text(`      Rule: ${issue.rule}`);
    });
  }

  if (errors && errors.length > 0) {
    blank();
    error('SonarQube Agentic Analysis returned errors:');
    errors.forEach((e) => {
      text(`  [${e.code}] ${e.message}`);
    });
  }

  blank();

  return issues.length;
}
