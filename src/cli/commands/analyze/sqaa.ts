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
import { existsSync } from 'node:fs';

import type { Command } from 'commander';

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import { blank, print, setMockUi, text } from '../../../ui';
import { SqaaProgress } from '../../../ui/components/sqaa-progress.js';
import { InvalidOptionError } from '../_common/error.js';
import type { BatchContext, BatchTally } from './sqaa-analysis';
import { runBatches } from './sqaa-analysis';
import {
  callSqaaApiAndDisplay,
  fetchWithRetry,
  readSqaaFileContent,
  toRelativePosixPath,
} from './sqaa-api';
import { confirmLargeChangeset, resolveCloudAuthAndProject } from './sqaa-auth';
import type { IgnoredFile } from './sqaa-changeset';
import { resolveChangeSet } from './sqaa-changeset';
import { applyExitCode, printFileDetails, printJsonReport, printSummary } from './sqaa-display';

/** Exit code when analysis succeeds and issues are found. */
const EXIT_CODE_ISSUES_FOUND = 51;

/** Change-set size above which the user is prompted to confirm before proceeding. */
const SQAA_LARGE_CHANGESET_THRESHOLD = 20;

export const VALID_FORMATS = ['text', 'json'] as const;
export type OutputFormat = (typeof VALID_FORMATS)[number];

export interface AnalyzeSqaaOptions {
  file?: string;
  staged?: boolean;
  base?: string;
  branch?: string;
  project?: string;
  force?: boolean;
  format?: OutputFormat;
}

export async function analyzeSqaa(
  options: AnalyzeSqaaOptions,
  auth: ResolvedAuth,
  command?: Command,
): Promise<void> {
  const { file, staged, base, branch, project, force, format = 'text' } = options;

  if (staged && base !== undefined) {
    throw new InvalidOptionError('--staged and --base cannot be used together');
  }

  if (file !== undefined) {
    if (!existsSync(file)) {
      throw new InvalidOptionError(`File not found: ${file}`);
    }
    await runSqaaAnalysis(file, auth, branch, project, command, format);
    return;
  }

  // Change-set mode: resolve files from Git.
  const { files, ignored } = await resolveChangeSet(process.cwd(), { staged, base });

  if (files.length === 0 && ignored.length === 0) {
    blank();
    text('SonarQube Agentic Analysis: no files in the change set to analyze.');
    return;
  }

  if (files.length === 0) {
    blank();
    text(
      'SonarQube Agentic Analysis: no files to analyze — all change set files were excluded (binary or oversized).',
    );
    return;
  }

  if (!force && files.length > SQAA_LARGE_CHANGESET_THRESHOLD) {
    const confirmed = await confirmLargeChangeset(files.length);
    if (!confirmed) return;
  }

  await runSqaaAnalysisOnFiles(files, ignored, auth, branch, project, command, format);
}

async function runSqaaAnalysis(
  file: string,
  auth: ResolvedAuth,
  branch?: string,
  explicitProject?: string,
  command?: Command,
  format: OutputFormat = 'text',
): Promise<void> {
  const resolved = resolveCloudAuthAndProject(auth, explicitProject, command);
  if (!resolved) return;

  const { cloudAuth, projectKey } = resolved;
  const fileContent = readSqaaFileContent(file);

  if (format === 'json') {
    const filePath = toRelativePosixPath(file);
    try {
      const response = await fetchWithRetry(cloudAuth, projectKey, file, fileContent, branch);
      const report = {
        files: [{ path: filePath, issues: response.issues, errors: response.errors }],
        ignored: [],
        failures: [],
        summary: { totalIssues: response.issues.length, totalFailures: 0 },
      };
      print(JSON.stringify(report, null, 2));
      if (response.issues.length > 0) process.exitCode = EXIT_CODE_ISSUES_FOUND;
    } catch (err) {
      const report = {
        files: [],
        ignored: [],
        failures: [{ path: filePath, message: (err as Error).message }],
        summary: { totalIssues: 0, totalFailures: 1 },
      };
      print(JSON.stringify(report, null, 2));
      process.exitCode = 1;
    }
    return;
  }

  const issueCount = await callSqaaApiAndDisplay(cloudAuth, projectKey, file, fileContent, branch);
  if (issueCount > 0) {
    process.exitCode = EXIT_CODE_ISSUES_FOUND;
  }
}

async function runSqaaAnalysisOnFiles(
  files: string[],
  ignored: IgnoredFile[],
  auth: ResolvedAuth,
  branch?: string,
  explicitProject?: string,
  command?: Command,
  format: OutputFormat = 'text',
): Promise<void> {
  const resolved = resolveCloudAuthAndProject(auth, explicitProject, command);
  if (!resolved) return;

  const { cloudAuth, projectKey } = resolved;
  const allPaths = files.map(toRelativePosixPath);

  if (format === 'json') {
    // Run batches with all UI suppressed, then emit structured JSON.
    const silentProgress = new SqaaProgress({ files: allPaths });
    const ctx: BatchContext = {
      files,
      allPaths,
      cloudAuth,
      projectKey,
      branch,
      progress: silentProgress,
    };
    setMockUi(true);
    let tally: BatchTally;
    try {
      tally = await runBatches(ctx);
    } finally {
      setMockUi(false);
    }
    printJsonReport(tally, ignored);
    applyExitCode(tally.totalIssues, tally.totalFailures);
    return;
  }

  const ignoredPaths = ignored.map((f) => toRelativePosixPath(f.path));
  const progress = new SqaaProgress({ files: allPaths, ignoredFiles: ignoredPaths });
  const ctx: BatchContext = { files, allPaths, cloudAuth, projectKey, branch, progress };
  const tally = await runBatches(ctx);

  progress.finish(tally.allResults.length);
  printFileDetails(tally.allResults);
  printSummary(tally.totalIssues, tally.totalErrors, tally.totalFailures);
}
