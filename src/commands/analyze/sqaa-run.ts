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

import {
  normalizePath,
  toRelativePosixPath as toRelativePosixPathOrNull,
} from '@/core/io/fs-utils.ts';
import { timed } from '@/core/observability/timed.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { SqaaForbiddenError } from '@/core/server/errors.ts';
import type { Console } from '@/core/ui/console.ts';
import { vortexUnavailableCommandMessage } from '@/core/vortex/availability-messages.ts';
import { recheckVortexEntitlement } from '@/core/vortex/entitlement.ts';

import type { RunContext, RunTally } from './sqaa-analysis.ts';
import { runAnalyses, withDisplayPath } from './sqaa-analysis.ts';
import { recordSqaaAnalysisTelemetry, tallyFromSqaaJsonReport } from './sqaa-analysis-telemetry.ts';
import { fetchWithRetry, readSqaaFileContent, toRelativePosixPath } from './sqaa-api.ts';
import type { ChangeSetResult } from './sqaa-changeset.ts';
import { resolveSqaaContext } from './sqaa-context.ts';
import type { SqaaDeepWireDepth } from './sqaa-depth.ts';
import {
  applyExitCode,
  buildJsonReport,
  displaySqaaResults,
  EXIT_CODE_ISSUES_FOUND,
  printSingleFileTextFailure,
  printSqaaTextReport,
  printVortexUnavailable,
  singleFileFailureReport,
  singleFileSuccessReport,
  type SqaaJsonReport,
} from './sqaa-display.ts';
import { globalSqaaErrorKind, isGlobalSqaaError } from './sqaa-errors.ts';
import type { ResolvedSqaaFileEntry } from './sqaa-file-arg.ts';
import { SqaaProgress } from './sqaa-progress.ts';
import { resolveSqaaConnectionAndProject } from './sqaa-resolution.ts';
import type {
  AnalyzeSqaaRunOptions,
  SingleFileRunOptions,
  SqaaBatchRunOptions,
  SqaaResolvedContext,
  SqaaRunPaths,
} from './sqaa-types.ts';
import type { SqaaAnalysisDepth } from './sqaa-wire-types.ts';

function resolveSqaaCommandExitCode(
  totalIssues: number,
  totalFailures: number,
  hasGlobalError = false,
): number {
  if (totalFailures > 0 || hasGlobalError) return 1;
  if (totalIssues > 0) return EXIT_CODE_ISSUES_FOUND;
  return 0;
}

export function finishSqaaTelemetryFromReport(
  report: SqaaJsonReport,
  runOptions: AnalyzeSqaaRunOptions,
  durationMs: number,
): void {
  const { telemetryCallerCommand, telemetryCtx, auth } = runOptions;
  if (!telemetryCallerCommand || !telemetryCtx || !auth) return;
  const exitCode =
    runOptions.telemetryProcessExitCode ??
    resolveSqaaCommandExitCode(
      report.summary.totalIssues,
      report.summary.totalFailures,
      report.globalError !== undefined,
    );
  recordSqaaAnalysisTelemetry(
    telemetryCtx,
    auth,
    telemetryCallerCommand,
    tallyFromSqaaJsonReport(report),
    durationMs,
    exitCode,
  );
}

function finishSqaaRun(tally: RunTally, durationMs: number, options: SqaaBatchRunOptions): void {
  const hasGlobalError = tally.globalError !== undefined;
  const exitCode = resolveSqaaCommandExitCode(
    tally.totalIssues,
    tally.totalFailures,
    hasGlobalError,
  );
  applyExitCode(tally.totalIssues, tally.totalFailures, hasGlobalError);
  if (options.telemetryCallerCommand && options.telemetryCtx) {
    recordSqaaAnalysisTelemetry(
      options.telemetryCtx,
      options.resolved.connection.auth,
      options.telemetryCallerCommand,
      tally,
      durationMs,
      exitCode,
    );
  }
}

/**
 * Resolve which of the two 403 causes (entitlement lost vs. usage limit) actually
 * happened and replace the report's generic 403 text with that resolved message,
 * mirroring what the text-mode branches already show via `printVortexUnavailable`.
 */
async function enrichForbiddenGlobalError(
  report: SqaaJsonReport,
  connection: SonarConnection,
): Promise<void> {
  if (!report.globalError) return;
  const status = await recheckVortexEntitlement(connection);
  report.globalError = {
    ...report.globalError,
    message: vortexUnavailableCommandMessage(status),
  };
}

async function printVortexUnavailableForForbidden(
  connection: SonarConnection,
  console: Console,
): Promise<void> {
  printVortexUnavailable(await recheckVortexEntitlement(connection), console);
}

async function printSqaaJsonReport(
  report: SqaaJsonReport,
  connection: SonarConnection,
  console: Console,
): Promise<void> {
  if (report.globalError?.kind === 'forbidden') {
    await enrichForbiddenGlobalError(report, connection);
  }
  console.print(JSON.stringify(report, null, 2));
}

function displaySingleFileReport(
  report: SqaaJsonReport,
  displayDepth: SqaaAnalysisDepth,
  console: Console,
): void {
  const file = report.files[0];
  displaySqaaResults(file.issues, file.errors, file.path, console, displayDepth);
}

export async function runSqaaAnalysesTallyForResolved(
  paths: SqaaRunPaths,
  resolved: SqaaResolvedContext,
  branch: string | undefined,
  wireDepth: SqaaDeepWireDepth | undefined,
  displayDepth: SqaaAnalysisDepth,
  console: Console,
): Promise<RunTally> {
  const silentProgress = new SqaaProgress({ files: paths.allPaths, silent: true, console });
  const ctx: RunContext = {
    ...paths,
    connection: resolved.connection,
    projectKey: resolved.projectKey,
    branch,
    progress: silentProgress,
    analysisDepth: wireDepth,
    displayAnalysisDepth: displayDepth,
  };
  return runAnalyses(ctx);
}

/**
 * `projectRoot` is required rather than defaulted: it is the base the wire path is relative
 * to, and a silent `process.cwd()` fallback would misbase it.
 * The returned report keeps cwd-relative paths, which is what the user should read.
 */
export async function fetchSingleFileReport(
  connection: SonarConnection,
  projectKey: string,
  file: string,
  fileContent: string,
  branch: string | undefined,
  options: {
    projectRoot: string;
    wireDepth?: SqaaDeepWireDepth;
    displayDepth?: SqaaAnalysisDepth;
  },
): Promise<{ report: SqaaJsonReport; error?: Error }> {
  const { projectRoot, wireDepth, displayDepth = 'STANDARD' } = options;
  const wirePath = toRelativePosixPath(file, projectRoot);
  const filePath = toRelativePosixPathOrNull(file, process.cwd()) ?? wirePath;
  try {
    const response = await fetchWithRetry(connection, projectKey, file, fileContent, branch, {
      pathBase: projectRoot,
      analysisDepth: wireDepth,
    });
    return {
      report: singleFileSuccessReport(
        filePath,
        withDisplayPath(response.issues, filePath),
        response.errors,
        displayDepth,
      ),
    };
  } catch (err) {
    const error = err as Error;
    const report = singleFileFailureReport(filePath, error.message, displayDepth);
    if (isGlobalSqaaError(error)) {
      report.globalError = {
        kind: globalSqaaErrorKind(error),
        message: error.message,
      };
    }
    return { report, error };
  }
}

export async function runSqaaAnalysis(file: string, options: SingleFileRunOptions): Promise<void> {
  const {
    connection: requestedConnection,
    branch,
    explicitProject,
    format = 'text',
    requireProject = true,
    wireDepth,
    displayDepth = 'STANDARD',
    telemetryCallerCommand,
    telemetryCtx,
    console,
  } = options;

  const resolution = await resolveSqaaConnectionAndProject(
    requestedConnection,
    explicitProject,
    console,
  );
  const resolved = resolveSqaaContext(resolution, { requireProject }, console);
  if (!resolved) return;

  const { connection, projectKey, projectRoot } = resolved;
  const { auth } = connection;
  const fileContent = readSqaaFileContent(file);

  const { result: fetchResult, durationMs } = await timed(() =>
    fetchSingleFileReport(connection, projectKey, file, fileContent, branch, {
      projectRoot,
      wireDepth,
      displayDepth,
    }),
  );
  const { report, error } = fetchResult;
  const filePath = toRelativePosixPath(file);

  if (format === 'json') {
    await printSqaaJsonReport(report, connection, console);
  } else if (error instanceof SqaaForbiddenError) {
    await printVortexUnavailableForForbidden(connection, console);
  } else if (error) {
    printSingleFileTextFailure(filePath, error, console, displayDepth);
  } else {
    displaySingleFileReport(report, displayDepth, console);
  }

  applyExitCode(report.summary.totalIssues, report.summary.totalFailures);
  finishSqaaTelemetryFromReport(report, { telemetryCallerCommand, telemetryCtx, auth }, durationMs);
}

export async function runSqaaAnalysisOnExplicitFiles(
  entries: ResolvedSqaaFileEntry[],
  options: SqaaBatchRunOptions,
): Promise<void> {
  const {
    resolved,
    branch,
    format = 'text',
    wireDepth,
    displayDepth = 'STANDARD',
    console,
  } = options;
  const cwd = process.cwd();
  const files = entries.map((e) => e.absolutePath);
  const allPaths = files.map((f) => toRelativePosixPath(f, cwd));
  // Throws for a file outside the project: the user named it explicitly, so a silent skip
  // would be worse than telling them it cannot be analyzed against this project.
  const wirePaths = files.map((f) => toRelativePosixPath(f, resolved.projectRoot));

  if (format === 'json') {
    const { result: tally, durationMs } = await timed(() =>
      runSqaaAnalysesTallyForResolved(
        { files, allPaths, wirePaths },
        resolved,
        branch,
        wireDepth,
        displayDepth,
        options.console,
      ),
    );
    const report = buildJsonReport(tally, [], allPaths, cwd, displayDepth);
    await printSqaaJsonReport(report, resolved.connection, console);
    finishSqaaRun(tally, durationMs, options);
    return;
  }

  const progress = new SqaaProgress({ files: allPaths, console: options.console });
  const ctx: RunContext = {
    files,
    allPaths,
    wirePaths,
    connection: resolved.connection,
    projectKey: resolved.projectKey,
    branch,
    progress,
    analysisDepth: wireDepth,
    displayAnalysisDepth: displayDepth,
  };
  const { result: tally, durationMs } = await timed(() => runAnalyses(ctx));
  progress.finish();
  if (tally.globalError instanceof SqaaForbiddenError) {
    await printVortexUnavailableForForbidden(resolved.connection, console);
  }
  printSqaaTextReport({ tally, allPaths, ignoredPaths: [], analysisDepth: displayDepth }, console);
  finishSqaaRun(tally, durationMs, options);
}

export async function runSqaaAnalysisOnFiles(
  changeSet: ChangeSetResult,
  options: SqaaBatchRunOptions,
): Promise<void> {
  const {
    resolved,
    branch,
    format = 'text',
    wireDepth,
    displayDepth = 'STANDARD',
    console,
  } = options;
  const { files, ignored, repoRoot } = changeSet;
  const { connection, projectKey, projectRoot } = resolved;
  const allPaths = files.map((f) => toRelativePosixPath(f, repoRoot));
  // Safe to throw-relativize: `excludeFilesOutsideProject` has already removed every file
  // that has no path relative to the project root.
  const wirePaths = files.map((f) => toRelativePosixPath(f, projectRoot));

  if (format === 'json') {
    const { result: tally, durationMs } = await timed(() =>
      runSqaaAnalysesTallyForResolved(
        { files, allPaths, wirePaths },
        resolved,
        branch,
        wireDepth,
        displayDepth,
        options.console,
      ),
    );
    const report = buildJsonReport(tally, ignored, allPaths, repoRoot, displayDepth);
    await printSqaaJsonReport(report, connection, console);
    finishSqaaRun(tally, durationMs, options);
    return;
  }

  const ignoredPaths = ignored.map(
    (f) => toRelativePosixPathOrNull(f.path, repoRoot) ?? normalizePath(f.path),
  );
  const progress = new SqaaProgress({
    files: allPaths,
    ignoredFiles: ignoredPaths,
    console: options.console,
  });
  const ctx: RunContext = {
    files,
    allPaths,
    wirePaths,
    connection,
    projectKey,
    branch,
    progress,
    analysisDepth: wireDepth,
    displayAnalysisDepth: displayDepth,
  };
  const { result: tally, durationMs } = await timed(() => runAnalyses(ctx));
  progress.finish();
  if (tally.globalError instanceof SqaaForbiddenError) {
    await printVortexUnavailableForForbidden(connection, console);
  }
  printSqaaTextReport({ tally, allPaths, ignoredPaths, analysisDepth: displayDepth }, console);
  finishSqaaRun(tally, durationMs, options);
}
