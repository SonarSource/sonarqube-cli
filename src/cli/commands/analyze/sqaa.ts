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
import { timed } from '../../../lib/timed.js';
import type { SqaaAnalysisDepth } from '../../../sonarqube/client';
import {
  emitSqaaAnalysisTelemetry,
  type SQAA_ANALYZE_AGENTIC_CALLER_COMMAND,
  tallyFromSqaaJsonReport,
} from '../../../telemetry/sqaa-analysis-telemetry.js';
import { print, text, warn } from '../../../ui';
import { SqaaProgress } from '../../../ui/components/sqaa-progress.js';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';
import type { RunContext, RunTally } from './sqaa-analysis';
import { runAnalyses } from './sqaa-analysis';
import { fetchWithRetry, readSqaaFileContent, toRelativePosixPath } from './sqaa-api';
import type { CloudAuth, SqaaAuthResolution } from './sqaa-auth';
import { confirmLargeChangeset, resolveCloudAuthAndProject } from './sqaa-auth';
import type { ChangeSetResult } from './sqaa-changeset';
import { resolveChangeSet } from './sqaa-changeset';
import {
  labelAnalysisDepth,
  parseSqaaDepthOption,
  resolveAnalysisDepth,
  type SqaaDeepWireDepth,
} from './sqaa-depth';
import {
  applyExitCode,
  buildJsonReport,
  displaySqaaResults,
  EXIT_CODE_ISSUES_FOUND,
  makeReport,
  printJsonReport,
  printSingleFileTextFailure,
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
  depth?: string;
  /** Internal: hooks force STANDARD without exposing `--depth` on the CLI. */
  forcedDepth?: SqaaAnalysisDepth;
}

export interface AnalyzeSqaaRunOptions {
  requireProject?: boolean;
  telemetryCallerCommand?: typeof SQAA_ANALYZE_AGENTIC_CALLER_COMMAND;
}

interface SqaaResolvedContext {
  cloudAuth: CloudAuth;
  projectKey: string;
}

interface SqaaDepthResolution {
  wireDepth: SqaaDeepWireDepth | undefined;
  displayDepth: SqaaAnalysisDepth;
}

interface SqaaBatchRunOptions {
  resolved: SqaaResolvedContext;
  auth: ResolvedAuth;
  branch?: string;
  format?: OutputFormat;
  wireDepth?: SqaaDeepWireDepth;
  displayDepth?: SqaaAnalysisDepth;
  telemetryCallerCommand?: typeof SQAA_ANALYZE_AGENTIC_CALLER_COMMAND;
}

interface SingleFileRunOptions {
  branch?: string;
  explicitProject?: string;
  format?: OutputFormat;
  requireProject?: boolean;
  wireDepth?: SqaaDeepWireDepth;
  displayDepth?: SqaaAnalysisDepth;
  telemetryCallerCommand?: typeof SQAA_ANALYZE_AGENTIC_CALLER_COMMAND;
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
): SqaaResolvedContext | null {
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

function parseOptionalDepth(rawDepth: string | undefined): SqaaAnalysisDepth | undefined {
  return rawDepth === undefined ? undefined : parseSqaaDepthOption(rawDepth);
}

function resolveDepthForMode(
  rawDepth: string | undefined,
  mode: 'single-file' | 'multi-file' | 'change-set',
  forcedDepth?: SqaaAnalysisDepth,
): SqaaDepthResolution {
  const explicitDepth = parseOptionalDepth(rawDepth);
  const wireDepth = resolveAnalysisDepth(explicitDepth, mode, forcedDepth);
  return { wireDepth, displayDepth: labelAnalysisDepth(wireDepth) };
}

async function confirmLargeRunIfNeeded(
  fileCount: number,
  force?: boolean,
  format: OutputFormat = 'text',
): Promise<boolean> {
  if (!force && format !== 'json' && fileCount > SQAA_LARGE_CHANGESET_THRESHOLD) {
    return await confirmLargeChangeset(fileCount);
  }
  return true;
}

async function runSqaaAnalysesTally(
  files: string[],
  allPaths: string[],
  resolved: SqaaResolvedContext,
  branch: string | undefined,
  wireDepth: SqaaDeepWireDepth | undefined,
  displayDepth: SqaaAnalysisDepth,
): Promise<RunTally> {
  const silentProgress = new SqaaProgress({ files: allPaths, silent: true });
  const ctx: RunContext = {
    files,
    allPaths,
    cloudAuth: resolved.cloudAuth,
    projectKey: resolved.projectKey,
    branch,
    progress: silentProgress,
    analysisDepth: wireDepth,
    displayAnalysisDepth: displayDepth,
  };
  return runAnalyses(ctx);
}

function resolveSqaaCommandExitCode(totalIssues: number, totalFailures: number): number {
  if (totalFailures > 0) return 1;
  if (totalIssues > 0) return EXIT_CODE_ISSUES_FOUND;
  return 0;
}

function emitSqaaTelemetryIfRequested(
  telemetryCallerCommand: typeof SQAA_ANALYZE_AGENTIC_CALLER_COMMAND | undefined,
  auth: ResolvedAuth,
  tally: RunTally,
  durationMs: number,
  exitCode: number,
): void {
  if (!telemetryCallerCommand) return;
  emitSqaaAnalysisTelemetry(telemetryCallerCommand, auth, tally, durationMs, exitCode);
}

function finishSqaaRun(tally: RunTally, durationMs: number, options: SqaaBatchRunOptions): void {
  const exitCode = resolveSqaaCommandExitCode(tally.totalIssues, tally.totalFailures);
  applyExitCode(tally.totalIssues, tally.totalFailures);
  emitSqaaTelemetryIfRequested(
    options.telemetryCallerCommand,
    options.auth,
    tally,
    durationMs,
    exitCode,
  );
}

function displaySingleFileReport(report: SqaaJsonReport, displayDepth: SqaaAnalysisDepth): void {
  const file = report.files[0];
  displaySqaaResults(file.issues, file.errors, file.path, displayDepth);
}

export async function analyzeSqaa(
  options: AnalyzeSqaaOptions,
  auth: ResolvedAuth,
  runOptions: AnalyzeSqaaRunOptions = {},
): Promise<void> {
  const { requireProject = true, telemetryCallerCommand } = runOptions;
  const {
    file: rawFiles,
    staged,
    base,
    branch,
    project,
    force,
    format = 'text',
    depth: rawDepth,
    forcedDepth,
  } = options;

  if (staged && base !== undefined) {
    throw new InvalidOptionError('--staged and --base cannot be used together');
  }

  if (rawFiles?.length) {
    await analyzeSqaaExplicitFiles(rawFiles, {
      auth,
      branch,
      project,
      force,
      format,
      rawDepth,
      forcedDepth,
      requireProject,
      telemetryCallerCommand,
    });
    return;
  }

  await analyzeSqaaChangeSet({
    auth,
    staged,
    base,
    branch,
    project,
    force,
    format,
    rawDepth,
    forcedDepth,
    requireProject,
    telemetryCallerCommand,
  });
}

async function analyzeSqaaExplicitFiles(
  rawFiles: string[],
  params: {
    auth: ResolvedAuth;
    branch?: string;
    project?: string;
    force?: boolean;
    format: OutputFormat;
    rawDepth?: string;
    forcedDepth?: SqaaAnalysisDepth;
    requireProject: boolean;
    telemetryCallerCommand?: SqaaBatchRunOptions['telemetryCallerCommand'];
  },
): Promise<void> {
  const entries = resolveSqaaFileArgs(rawFiles);
  const {
    auth,
    branch,
    project,
    force,
    format,
    rawDepth,
    forcedDepth,
    requireProject,
    telemetryCallerCommand,
  } = params;

  if (entries.length === 1) {
    const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'single-file', forcedDepth);
    await runSqaaAnalysis(entries[0].absolutePath, auth, {
      branch,
      explicitProject: project,
      format,
      requireProject,
      wireDepth,
      displayDepth,
      telemetryCallerCommand,
    });
    return;
  }

  const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'multi-file', forcedDepth);
  const resolution = await resolveCloudAuthAndProject(auth, project);
  const resolved = resolveSqaaContext(resolution, { requireProject });
  if (!resolved) return;

  if (!(await confirmLargeRunIfNeeded(entries.length, force, format))) return;

  await runSqaaAnalysisOnExplicitFiles(entries, {
    resolved,
    auth,
    branch,
    format,
    wireDepth,
    displayDepth,
    telemetryCallerCommand,
  });
}

async function analyzeSqaaChangeSet(params: {
  auth: ResolvedAuth;
  staged?: boolean;
  base?: string;
  branch?: string;
  project?: string;
  force?: boolean;
  format: OutputFormat;
  rawDepth?: string;
  forcedDepth?: SqaaAnalysisDepth;
  requireProject: boolean;
  telemetryCallerCommand?: SqaaBatchRunOptions['telemetryCallerCommand'];
}): Promise<void> {
  const {
    auth,
    staged,
    base,
    branch,
    project,
    force,
    format,
    rawDepth,
    forcedDepth,
    requireProject,
    telemetryCallerCommand,
  } = params;
  const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'change-set', forcedDepth);

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

  const resolution = await resolveCloudAuthAndProject(auth, project, changeSet.repoRoot);
  const resolved = resolveSqaaContext(resolution, { requireProject });
  if (!resolved) return;

  if (!(await confirmLargeRunIfNeeded(changeSet.files.length, force, format))) return;

  await runSqaaAnalysisOnFiles(changeSet, {
    resolved,
    auth,
    branch,
    format,
    wireDepth,
    displayDepth,
    telemetryCallerCommand,
  });
}

async function runSqaaAnalysis(
  file: string,
  auth: ResolvedAuth,
  options: SingleFileRunOptions = {},
): Promise<void> {
  const {
    branch,
    explicitProject,
    format = 'text',
    requireProject = true,
    wireDepth,
    displayDepth = 'STANDARD',
    telemetryCallerCommand,
  } = options;

  const resolution = await resolveCloudAuthAndProject(auth, explicitProject);
  const resolved = resolveSqaaContext(resolution, { requireProject });
  if (!resolved) return;

  const { cloudAuth, projectKey } = resolved;
  const fileContent = readSqaaFileContent(file);

  const { result: fetchResult, durationMs } = await timed(() =>
    fetchSingleFileReport(
      cloudAuth,
      projectKey,
      file,
      fileContent,
      branch,
      wireDepth,
      displayDepth,
    ),
  );
  const { report, error } = fetchResult;
  const filePath = toRelativePosixPath(file);

  if (format === 'json') {
    print(JSON.stringify(report, null, 2));
  } else if (error) {
    printSingleFileTextFailure(filePath, error, displayDepth);
  } else {
    displaySingleFileReport(report, displayDepth);
  }

  const exitCode = resolveSqaaCommandExitCode(
    report.summary.totalIssues,
    report.summary.totalFailures,
  );
  applyExitCode(report.summary.totalIssues, report.summary.totalFailures);
  emitSqaaTelemetryIfRequested(
    telemetryCallerCommand,
    auth,
    tallyFromSqaaJsonReport(report),
    durationMs,
    exitCode,
  );
}

async function runSqaaAnalysisOnExplicitFiles(
  entries: ResolvedSqaaFileEntry[],
  options: SqaaBatchRunOptions,
): Promise<void> {
  const { resolved, branch, format = 'text', wireDepth, displayDepth = 'STANDARD' } = options;
  const cwd = process.cwd();
  const files = entries.map((e) => e.absolutePath);
  const allPaths = files.map((f) => toRelativePosixPath(f, cwd));

  if (format === 'json') {
    const { result: tally, durationMs } = await timed(() =>
      runSqaaAnalysesTally(files, allPaths, resolved, branch, wireDepth, displayDepth),
    );
    printJsonReport(tally, [], allPaths, cwd, displayDepth);
    finishSqaaRun(tally, durationMs, options);
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
    analysisDepth: wireDepth,
    displayAnalysisDepth: displayDepth,
  };
  try {
    const { result: tally, durationMs } = await timed(() => runAnalyses(ctx));
    progress.finish();
    printSqaaTextReport({ tally, allPaths, ignoredPaths: [], analysisDepth: displayDepth });
    finishSqaaRun(tally, durationMs, options);
  } catch (err) {
    progress.finish();
    throw err;
  }
}

async function runSqaaAnalysisOnFiles(
  changeSet: ChangeSetResult,
  options: SqaaBatchRunOptions,
): Promise<void> {
  const { resolved, branch, format = 'text', wireDepth, displayDepth = 'STANDARD' } = options;
  const { files, ignored, repoRoot } = changeSet;
  const { cloudAuth, projectKey } = resolved;
  const allPaths = files.map((f) => toRelativePosixPath(f, repoRoot));

  if (format === 'json') {
    const { result: tally, durationMs } = await timed(() =>
      runSqaaAnalysesTally(files, allPaths, resolved, branch, wireDepth, displayDepth),
    );
    printJsonReport(tally, ignored, allPaths, repoRoot, displayDepth);
    finishSqaaRun(tally, durationMs, options);
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
    analysisDepth: wireDepth,
    displayAnalysisDepth: displayDepth,
  };
  try {
    const { result: tally, durationMs } = await timed(() => runAnalyses(ctx));
    progress.finish();
    printSqaaTextReport({ tally, allPaths, ignoredPaths, analysisDepth: displayDepth });
    finishSqaaRun(tally, durationMs, options);
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
  wireDepth?: SqaaDeepWireDepth,
  displayDepth: SqaaAnalysisDepth = 'STANDARD',
): Promise<{ report: SqaaJsonReport; error?: Error }> {
  const filePath = toRelativePosixPath(file);
  try {
    const response = await fetchWithRetry(cloudAuth, projectKey, file, fileContent, branch, {
      analysisDepth: wireDepth,
    });
    return {
      report: singleFileSuccessReport(filePath, response.issues, response.errors, displayDepth),
    };
  } catch (err) {
    const error = err as Error;
    return {
      report: singleFileFailureReport(filePath, error.message, displayDepth),
      error,
    };
  }
}

async function buildSqaaJsonReportFromEntries(
  entries: ResolvedSqaaFileEntry[],
  resolved: SqaaResolvedContext,
  branch: string | undefined,
  wireDepth: SqaaDeepWireDepth | undefined,
  displayDepth: SqaaAnalysisDepth,
): Promise<SqaaJsonReport> {
  if (entries.length === 1) {
    const { absolutePath } = entries[0];
    const fileContent = readSqaaFileContent(absolutePath);
    const { report } = await fetchSingleFileReport(
      resolved.cloudAuth,
      resolved.projectKey,
      absolutePath,
      fileContent,
      branch,
      wireDepth,
      displayDepth,
    );
    return report;
  }

  const cwd = process.cwd();
  const absolutePaths = entries.map((e) => e.absolutePath);
  const allPaths = absolutePaths.map((f) => toRelativePosixPath(f, cwd));
  const tally = await runSqaaAnalysesTally(
    absolutePaths,
    allPaths,
    resolved,
    branch,
    wireDepth,
    displayDepth,
  );
  return buildJsonReport(tally, [], allPaths, cwd, displayDepth);
}

async function buildSqaaJsonReportFromChangeSet(
  options: AnalyzeSqaaOptions,
  auth: ResolvedAuth,
  rawDepth: string | undefined,
  forcedDepth: SqaaAnalysisDepth | undefined,
): Promise<SqaaJsonReport | null> {
  const { staged, base, branch, project, force } = options;
  const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'change-set', forcedDepth);

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

  if (!(await confirmLargeRunIfNeeded(changeSet.files.length, force, options.format ?? 'text'))) {
    return null;
  }

  const { files, ignored, repoRoot } = changeSet;
  const allPaths = files.map((f) => toRelativePosixPath(f, repoRoot));
  const tally = await runSqaaAnalysesTally(
    files,
    allPaths,
    resolved,
    branch,
    wireDepth,
    displayDepth,
  );
  return buildJsonReport(tally, ignored, allPaths, repoRoot, displayDepth);
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
  const { file: rawFiles, branch, project, force, depth: rawDepth, forcedDepth } = options;

  if (rawFiles?.length) {
    const entries = resolveSqaaFileArgs(rawFiles);
    const resolution = await resolveCloudAuthAndProject(auth, project);
    const resolved = resolveSqaaContext(resolution, { requireProject: false });
    if (!resolved) return null;

    if (entries.length === 1) {
      const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'single-file', forcedDepth);
      return buildSqaaJsonReportFromEntries(entries, resolved, branch, wireDepth, displayDepth);
    }

    const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'multi-file', forcedDepth);
    if (!(await confirmLargeRunIfNeeded(entries.length, force, options.format ?? 'text'))) {
      return null;
    }

    return buildSqaaJsonReportFromEntries(entries, resolved, branch, wireDepth, displayDepth);
  }

  return buildSqaaJsonReportFromChangeSet(options, auth, rawDepth, forcedDepth);
}
