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
import { blank, print, text } from '../../../ui';
import { SqaaProgress } from '../../../ui/components/sqaa-progress.js';
import { InvalidOptionError } from '../_common/error.js';
import type { RunContext } from './sqaa-analysis';
import { runAnalyses } from './sqaa-analysis';
import {
  callSqaaApiAndDisplay,
  fetchWithRetry,
  readSqaaFileContent,
  toRelativePosixPath,
} from './sqaa-api';
import type { CloudAuth } from './sqaa-auth';
import { confirmLargeChangeset, resolveCloudAuthAndProject } from './sqaa-auth';
import type { ChangeSetResult } from './sqaa-changeset';
import { resolveChangeSet } from './sqaa-changeset';
import {
  applyExitCode,
  EXIT_CODE_ISSUES_FOUND,
  printFileDetails,
  printJsonReport,
  printSummary,
} from './sqaa-display';

/** Change-set size above which the user is prompted to confirm before proceeding. */
const SQAA_LARGE_CHANGESET_THRESHOLD = 50;

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
  const changeSet = await resolveChangeSet(process.cwd(), { staged, base });

  if (changeSet.files.length === 0 && changeSet.ignored.length === 0) {
    blank();
    text('SonarQube Agentic Analysis: no files in the change set to analyze.');
    return;
  }

  if (changeSet.files.length === 0) {
    blank();
    text(
      'SonarQube Agentic Analysis: no files to analyze — all change set files were excluded (binary or oversized).',
    );
    return;
  }

  // Resolve cloud auth + project key BEFORE prompting.
  // Pass repoRoot so we reuse the already-resolved root instead of spawning git again.
  const resolved = await resolveCloudAuthAndProject(auth, project, command, changeSet.repoRoot);
  if (!resolved) return;

  // JSON mode is consumed by scripts/CI: never block on an interactive prompt
  if (!force && format !== 'json' && changeSet.files.length > SQAA_LARGE_CHANGESET_THRESHOLD) {
    const confirmed = await confirmLargeChangeset(changeSet.files.length);
    if (!confirmed) return;
  }

  await runSqaaAnalysisOnFiles(changeSet, resolved, branch, format);
}

async function runSqaaAnalysis(
  file: string,
  auth: ResolvedAuth,
  branch?: string,
  explicitProject?: string,
  command?: Command,
  format: OutputFormat = 'text',
): Promise<void> {
  const resolved = await resolveCloudAuthAndProject(auth, explicitProject, command);
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
        skipped: [],
        summary: { totalIssues: response.issues.length, totalFailures: 0, totalSkipped: 0 },
      };
      print(JSON.stringify(report, null, 2));
      if (response.issues.length > 0) process.exitCode = EXIT_CODE_ISSUES_FOUND;
    } catch (err) {
      const report = {
        files: [],
        ignored: [],
        failures: [{ path: filePath, message: (err as Error).message }],
        skipped: [],
        summary: { totalIssues: 0, totalFailures: 1, totalSkipped: 0 },
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
  changeSet: ChangeSetResult,
  resolved: { cloudAuth: CloudAuth; projectKey: string },
  branch?: string,
  format: OutputFormat = 'text',
): Promise<void> {
  const { files, ignored, repoRoot } = changeSet;
  const { cloudAuth, projectKey } = resolved;
  const allPaths = files.map((f) => toRelativePosixPath(f, repoRoot));

  if (format === 'json') {
    // Suppress all UI rendering at the component level (no global mock state).
    const silentProgress = new SqaaProgress({ files: allPaths, silent: true });
    const ctx: RunContext = {
      files,
      allPaths,
      cloudAuth,
      projectKey,
      branch,
      progress: silentProgress,
      pathBase: repoRoot,
    };
    const tally = await runAnalyses(ctx);
    printJsonReport(tally, ignored, allPaths, repoRoot);
    applyExitCode(tally.totalIssues, tally.totalFailures);
    return;
  }

  const ignoredPaths = ignored.map((f) => toRelativePosixPath(f.path, repoRoot));
  const progress = new SqaaProgress({ files: allPaths, ignoredFiles: ignoredPaths });
  const ctx: RunContext = {
    files,
    allPaths,
    cloudAuth,
    projectKey,
    branch,
    progress,
    pathBase: repoRoot,
  };
  progress.start();
  const tally = await runAnalyses(ctx);

  progress.finish(tally.allResults.length);
  printFileDetails(tally.allResults);
  printSummary(tally.totalIssues, tally.totalErrors, tally.totalFailures);
}
