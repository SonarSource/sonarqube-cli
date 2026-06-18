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
import type { ResolvedAuth } from '../../../lib/auth-resolver';
import { print, text, warn } from '../../../ui';
import { SqaaProgress } from '../../../ui/components/sqaa-progress.js';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';
import type { RunContext } from './sqaa-analysis';
import { runAnalyses } from './sqaa-analysis';
import {
  callSqaaApiAndDisplay,
  fetchWithRetry,
  readSqaaFileContent,
  toRelativePosixPath,
} from './sqaa-api';
import type { CloudAuth, SqaaAuthResolution } from './sqaa-auth';
import { confirmLargeChangeset, resolveCloudAuthAndProject } from './sqaa-auth';
import type { ChangeSetResult } from './sqaa-changeset';
import { resolveChangeSet } from './sqaa-changeset';
import {
  applyExitCode,
  buildJsonReport,
  makeReport,
  printJsonReport,
  printSqaaTextReport,
  singleFileFailureReport,
  singleFileSuccessReport,
  type SqaaJsonReport,
} from './sqaa-display';
import { type ResolvedSqaaFileEntry, resolveSqaaFileArgs } from './sqaa-file-arg';

/** Change-set size above which the user is prompted to confirm before proceeding. */
const SQAA_LARGE_CHANGESET_THRESHOLD = 50;

export const VALID_FORMATS = ['text', 'json'] as const;
export type OutputFormat = (typeof VALID_FORMATS)[number];

export interface AnalyzeSqaaOptions {
  file?: string[];
  staged?: boolean;
  base?: string;
  branch?: string;
  project?: string;
  force?: boolean;
  format?: OutputFormat;
}

/**
 * Apply the command's policy to an auth/project resolution. This is where the
 * caller (not the resolver) decides what a missing project means:
 * - `requireProject` (explicit `analyze agentic` / `verify`): throw so the command
 *   exits with code 1 instead of skipping silently.
 * - otherwise (the bare `sonar analyze` catch-all): warn and return null so the
 *   surrounding command can proceed with its other analyses.
 *
 * A non-Cloud connection is always a graceful skip (the warning was already emitted
 * by resolveCloudAuth), since agentic analysis is Cloud-only.
 */
function resolveSqaaContext(
  resolution: SqaaAuthResolution,
  policy: { requireProject: boolean },
): { cloudAuth: CloudAuth; projectKey: string } | null {
  switch (resolution.kind) {
    case 'resolved':
      return { cloudAuth: resolution.cloudAuth, projectKey: resolution.projectKey };
    case 'no-cloud':
      return null;
    case 'no-project':
      if (policy.requireProject) {
        throw new CommandFailedError(
          'SonarQube Agentic Analysis requires a project, but none is configured for this directory.',
          {
            remediationHint:
              "Specify one with --project, or run 'sonar integrate' to configure this project.",
          },
        );
      }
      warn(
        'SonarQube Agentic Analysis skipped: no project configured. Specify one with --project or run: sonar integrate',
      );
      return null;
  }
}

export async function analyzeSqaa(
  options: AnalyzeSqaaOptions,
  auth: ResolvedAuth,
  runOptions: { requireProject?: boolean } = {},
): Promise<void> {
  // Explicit `analyze agentic` / `verify` require a project (exit 1 when missing);
  // the bare `sonar analyze` catch-all opts out so it can still run other analyses.
  const { requireProject = true } = runOptions;
  const { file: rawFiles, staged, base, branch, project, force, format = 'text' } = options;

  if (staged && base !== undefined) {
    throw new InvalidOptionError('--staged and --base cannot be used together');
  }

  if (rawFiles?.length) {
    const entries = resolveSqaaFileArgs(rawFiles);
    if (entries.length === 1) {
      await runSqaaAnalysis(entries[0].absolutePath, auth, branch, project, format, requireProject);
      return;
    }

    const resolution = await resolveCloudAuthAndProject(auth, project);
    const resolved = resolveSqaaContext(resolution, { requireProject });
    if (!resolved) return;

    if (!force && format !== 'json' && entries.length > SQAA_LARGE_CHANGESET_THRESHOLD) {
      const confirmed = await confirmLargeChangeset(entries.length);
      if (!confirmed) return;
    }

    await runSqaaAnalysisOnExplicitFiles(entries, resolved, branch, format);
    return;
  }

  // Change-set mode: resolve files from Git.
  const changeSet = await resolveChangeSet(process.cwd(), { staged, base });

  if (changeSet.files.length === 0 && changeSet.ignored.length === 0) {
    text('SonarQube Agentic Analysis: no files in the change set to analyze.');
    return;
  }

  if (changeSet.files.length === 0) {
    text(
      'SonarQube Agentic Analysis: no files to analyze — all change set files were excluded (binary or oversized).',
    );
    return;
  }

  // Resolve cloud auth + project key BEFORE prompting.
  // Pass repoRoot so we reuse the already-resolved root instead of spawning git again.
  const resolution = await resolveCloudAuthAndProject(auth, project, changeSet.repoRoot);
  const resolved = resolveSqaaContext(resolution, { requireProject });
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
  format: OutputFormat = 'text',
  requireProject = true,
): Promise<void> {
  const resolution = await resolveCloudAuthAndProject(auth, explicitProject);
  const resolved = resolveSqaaContext(resolution, { requireProject });
  if (!resolved) return;

  const { cloudAuth, projectKey } = resolved;
  const fileContent = readSqaaFileContent(file);

  if (format === 'json') {
    const report = await fetchSingleFileReport(cloudAuth, projectKey, file, fileContent, branch);
    print(JSON.stringify(report, null, 2));
    applyExitCode(report.summary.totalIssues, report.summary.totalFailures);
    return;
  }

  await callSqaaApiAndDisplay(cloudAuth, projectKey, file, fileContent, branch);
}

async function runSqaaAnalysisOnExplicitFiles(
  entries: ResolvedSqaaFileEntry[],
  resolved: { cloudAuth: CloudAuth; projectKey: string },
  branch?: string,
  format: OutputFormat = 'text',
): Promise<void> {
  const cwd = process.cwd();
  const files = entries.map((e) => e.absolutePath);
  const allPaths = files.map((f) => toRelativePosixPath(f, cwd));

  if (format === 'json') {
    const silentProgress = new SqaaProgress({ files: allPaths, silent: true });
    const ctx: RunContext = {
      files,
      allPaths,
      cloudAuth: resolved.cloudAuth,
      projectKey: resolved.projectKey,
      branch,
      progress: silentProgress,
    };
    const tally = await runAnalyses(ctx);
    printJsonReport(tally, [], allPaths, cwd);
    applyExitCode(tally.totalIssues, tally.totalFailures);
    return;
  }

  const progress = new SqaaProgress({ files: allPaths });
  const ctx: RunContext = {
    files,
    allPaths,
    cloudAuth: resolved.cloudAuth,
    projectKey: resolved.projectKey,
    branch,
    progress,
  };
  try {
    const tally = await runAnalyses(ctx);
    progress.finish();
    printSqaaTextReport({ tally, allPaths, ignoredPaths: [] });
  } catch (err) {
    progress.finish();
    throw err;
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
  };
  try {
    const tally = await runAnalyses(ctx);
    progress.finish();
    printSqaaTextReport({ tally, allPaths, ignoredPaths });
  } catch (err) {
    progress.finish();
    throw err;
  }
}

async function fetchSingleFileReport(
  cloudAuth: CloudAuth,
  projectKey: string,
  file: string,
  fileContent: string,
  branch?: string,
): Promise<SqaaJsonReport> {
  const filePath = toRelativePosixPath(file);
  try {
    const response = await fetchWithRetry(cloudAuth, projectKey, file, fileContent, branch);
    return singleFileSuccessReport(filePath, response.issues, response.errors);
  } catch (err) {
    return singleFileFailureReport(filePath, (err as Error).message);
  }
}

/**
 * Run SQAA and return the JSON report without printing it.
 * Returns null when SQAA is not available (non-Cloud connection or no project configured).
 * Used by `analyzeAll` to build a combined JSON report.
 */
export async function buildSqaaJsonReport(
  options: AnalyzeSqaaOptions,
  auth: ResolvedAuth,
): Promise<SqaaJsonReport | null> {
  const { file: rawFiles, staged, base, branch, project, force } = options;

  if (rawFiles?.length) {
    const entries = resolveSqaaFileArgs(rawFiles);
    const resolution = await resolveCloudAuthAndProject(auth, project);
    const resolved = resolveSqaaContext(resolution, { requireProject: false });
    if (!resolved) return null;

    if (entries.length === 1) {
      const { absolutePath } = entries[0];
      const fileContent = readSqaaFileContent(absolutePath);
      return fetchSingleFileReport(
        resolved.cloudAuth,
        resolved.projectKey,
        absolutePath,
        fileContent,
        branch,
      );
    }

    if (!force && options.format !== 'json' && entries.length > SQAA_LARGE_CHANGESET_THRESHOLD) {
      const confirmed = await confirmLargeChangeset(entries.length);
      if (!confirmed) return null;
    }

    const cwd = process.cwd();
    const absolutePaths = entries.map((e) => e.absolutePath);
    const allPaths = absolutePaths.map((f) => toRelativePosixPath(f, cwd));
    const silentProgress = new SqaaProgress({ files: allPaths, silent: true });
    const ctx: RunContext = {
      files: absolutePaths,
      allPaths,
      cloudAuth: resolved.cloudAuth,
      projectKey: resolved.projectKey,
      branch,
      progress: silentProgress,
    };
    const tally = await runAnalyses(ctx);
    return buildJsonReport(tally, [], allPaths, cwd);
  }

  // Change-set mode
  const changeSet = await resolveChangeSet(process.cwd(), { staged, base });
  if (changeSet.files.length === 0) {
    return makeReport(
      [],
      [],
      changeSet.ignored.map((f) => ({ path: f.path, reason: f.reason })),
    );
  }

  const resolution = await resolveCloudAuthAndProject(auth, project, changeSet.repoRoot);
  const resolved = resolveSqaaContext(resolution, { requireProject: false });
  if (!resolved) return null;

  // JSON mode is consumed by scripts/CI: never block on an interactive prompt
  if (
    !force &&
    options.format !== 'json' &&
    changeSet.files.length > SQAA_LARGE_CHANGESET_THRESHOLD
  ) {
    const confirmed = await confirmLargeChangeset(changeSet.files.length);
    if (!confirmed) return null;
  }

  const { files, ignored, repoRoot } = changeSet;
  const { cloudAuth, projectKey } = resolved;
  const allPaths = files.map((f) => toRelativePosixPath(f, repoRoot));
  const silentProgress = new SqaaProgress({ files: allPaths, silent: true });
  const ctx: RunContext = {
    files,
    allPaths,
    cloudAuth,
    projectKey,
    branch,
    progress: silentProgress,
  };

  const tally = await runAnalyses(ctx);
  return buildJsonReport(tally, ignored, allPaths, repoRoot);
}
