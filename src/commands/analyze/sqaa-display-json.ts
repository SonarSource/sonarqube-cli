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

// JSON report builders for SQAA results.

import { print } from '../../core/ui';
import type { SqaaAnalysisDepth, SqaaIssue } from '../../sonarqube/client.ts';
import type { FileFailure, FileSuccess, RunTally } from './sqaa-analysis.ts';
import { toRelativePosixPath } from './sqaa-api.ts';
import type { IgnoredFile } from './sqaa-changeset.ts';

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
  analysisDepth: SqaaAnalysisDepth;
}

export function makeReport(
  files: SqaaJsonReport['files'],
  failures: SqaaJsonReport['failures'],
  ignored: SqaaJsonReport['ignored'] = [],
  analysisDepth: SqaaAnalysisDepth = 'STANDARD',
): SqaaJsonReport {
  return {
    files,
    ignored,
    failures,
    skipped: [],
    summary: {
      totalIssues: files.reduce((n, f) => n + f.issues.length, 0),
      totalFailures: failures.length,
      totalSkipped: 0,
    },
    analysisDepth,
  };
}

export function singleFileSuccessReport(
  filePath: string,
  issues: SqaaIssue[],
  errors?: Array<{ code: string; message: string }> | null,
  analysisDepth: SqaaAnalysisDepth = 'STANDARD',
): SqaaJsonReport {
  return makeReport([{ path: filePath, issues, errors }], [], [], analysisDepth);
}

export function singleFileFailureReport(
  filePath: string,
  message: string,
  analysisDepth: SqaaAnalysisDepth = 'STANDARD',
): SqaaJsonReport {
  return makeReport([], [{ path: filePath, message }], [], analysisDepth);
}

export function buildJsonReport(
  tally: RunTally,
  ignored: IgnoredFile[],
  allPaths: string[],
  pathBase?: string,
  analysisDepth: SqaaAnalysisDepth = 'STANDARD',
): SqaaJsonReport {
  const files = tally.allResults
    .filter((r): r is FileSuccess => !('failure' in r))
    .map((r) => ({ path: r.filePath, issues: r.issues, errors: r.errors }));

  const failures = tally.allResults
    .filter((r): r is FileFailure => 'failure' in r)
    .map((r) => ({ path: r.filePath, message: r.failure.message }));

  const processedPaths = new Set<string>(tally.allResults.map((r) => r.filePath));
  const skipped = allPaths.filter((p) => !processedPaths.has(p));

  return {
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
    analysisDepth,
  };
}

export function printJsonReport(
  tally: RunTally,
  ignored: IgnoredFile[],
  allPaths: string[],
  pathBase?: string,
  analysisDepth: SqaaAnalysisDepth = 'STANDARD',
): void {
  print(
    JSON.stringify(buildJsonReport(tally, ignored, allPaths, pathBase, analysisDepth), null, 2),
  );
}
