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

import { relative } from 'node:path';

import { timed } from '@/core/observability/timed.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { SqaaForbiddenError } from '@/core/server/errors.ts';
import type { Console } from '@/core/ui/console.ts';
import { vortexUnavailableCommandMessage } from '@/core/vortex/availability-messages.ts';
import { recheckVortexEntitlement } from '@/core/vortex/entitlement.ts';

import type { RunTally } from './sqaa-analysis.ts';
import { mergeTallies, runAnalyses } from './sqaa-analysis.ts';
import { recordSqaaAnalysisTelemetry, tallyFromSqaaJsonReport } from './sqaa-analysis-telemetry.ts';
import { fetchWithRetry, readSqaaFileContent } from './sqaa-api.ts';
import type { ChangeSetResult, IgnoredFile } from './sqaa-changeset.ts';
import { resolveSqaaContext } from './sqaa-context.ts';
import type { SqaaDeepWireDepth } from './sqaa-depth.ts';
import {
  applyExitCode,
  buildJsonReport,
  displaySqaaResults,
  EXIT_CODE_ISSUES_FOUND,
  ignoredReportPath,
  printSingleFileTextFailure,
  printSqaaTextReport,
  printVortexUnavailable,
  singleFileFailureReport,
  singleFileSuccessReport,
  type SqaaJsonReport,
} from './sqaa-display.ts';
import { globalSqaaErrorKind, isGlobalSqaaError } from './sqaa-errors.ts';
import {
  assertExplicitFilesAnalyzable,
  resolveSqaaRunFiles,
  soleFile,
  type SqaaPath,
  withDisplayFilePath,
} from './sqaa-paths.ts';
import { SqaaProgress } from './sqaa-progress.ts';
import { resolveSqaaConnectionAndProject } from './sqaa-resolution.ts';
import type {
  AnalyzeSqaaRunOptions,
  SingleFileRunOptions,
  SqaaBatchRunOptions,
  SqaaProjectFiles,
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

/**
 * Analyzes each project's files in turn and merges the tallies. Every project gets its own
 * progress because `runAnalyses` indexes progress by position within its own paths. A global
 * error (auth, entitlement) applies to the whole organization, so it stops the remaining projects.
 */
export async function runSqaaGroups(
  projects: SqaaProjectFiles[],
  connection: SonarConnection,
  run: {
    branch: string | undefined;
    wireDepth: SqaaDeepWireDepth | undefined;
    displayDepth: SqaaAnalysisDepth;
    console: Console;
    silent: boolean;
  },
): Promise<RunTally> {
  const tallies: RunTally[] = [];
  for (const [index, { projectKey, files }] of projects.entries()) {
    const progress = new SqaaProgress({
      files: files.map((file) => file.displayPath),
      project: { key: projectKey, index: index + 1, total: projects.length },
      silent: run.silent,
      console: run.console,
    });
    const tally = await runAnalyses({
      paths: files,
      connection,
      projectKey,
      branch: run.branch,
      progress,
      analysisDepth: run.wireDepth,
      displayAnalysisDepth: run.displayDepth,
    });
    progress.finish();
    tallies.push(tally);
    if (tally.globalError) break;
  }
  return mergeTallies(tallies);
}

export async function fetchSingleFileReport(
  connection: SonarConnection,
  projectKey: string,
  path: SqaaPath,
  fileContent: string,
  branch?: string,
  wireDepth?: SqaaDeepWireDepth,
  displayDepth: SqaaAnalysisDepth = 'STANDARD',
): Promise<{ report: SqaaJsonReport; error?: Error }> {
  try {
    const response = await fetchWithRetry(
      connection,
      projectKey,
      { path: path.serverPath, content: fileContent },
      branch,
      {
        analysisDepth: wireDepth,
      },
    );
    return {
      report: singleFileSuccessReport(
        path.displayPath,
        withDisplayFilePath(response.issues, path.displayPath),
        response.errors,
        displayDepth,
        projectKey,
      ),
    };
  } catch (err) {
    const error = err as Error;
    const report = singleFileFailureReport(
      path.displayPath,
      error.message,
      displayDepth,
      projectKey,
    );
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
    [file],
  );
  const resolved = resolveSqaaContext(resolution, { requireProject }, console);
  if (!resolved) return;
  assertExplicitFilesAnalyzable(resolved.ignored, resolved.projectRoots);

  const { connection } = resolved;
  const { projectKey, file: path } = soleFile(resolveSqaaRunFiles(resolved.groups, process.cwd()));
  const { auth } = connection;
  const fileContent = readSqaaFileContent(file);

  const { result: fetchResult, durationMs } = await timed(() =>
    fetchSingleFileReport(
      connection,
      projectKey,
      path,
      fileContent,
      branch,
      wireDepth,
      displayDepth,
    ),
  );
  const { report, error } = fetchResult;

  if (format === 'json') {
    await printSqaaJsonReport(report, connection, console);
  } else if (error instanceof SqaaForbiddenError) {
    await printVortexUnavailableForForbidden(connection, console);
  } else if (error) {
    printSingleFileTextFailure(path.displayPath, error, console, displayDepth);
  } else {
    displaySingleFileReport(report, displayDepth, console);
  }

  applyExitCode(report.summary.totalIssues, report.summary.totalFailures);
  finishSqaaTelemetryFromReport(report, { telemetryCallerCommand, telemetryCtx, auth }, durationMs);
}

export async function runSqaaAnalysisOnExplicitFiles(options: SqaaBatchRunOptions): Promise<void> {
  await runSqaaBatch(options, process.cwd(), []);
}

export async function runSqaaAnalysisOnFiles(
  changeSet: ChangeSetResult,
  options: SqaaBatchRunOptions,
): Promise<void> {
  await runSqaaBatch(options, changeSet.repoRoot, changeSet.ignored, changeSet.repoRoot);
}

/** `displayBase` is what reported paths are relative to: cwd for `--file`, the repository root for a change set. */
async function runSqaaBatch(
  options: SqaaBatchRunOptions,
  displayBase: string,
  ignored: IgnoredFile[],
  repoRoot?: string,
): Promise<void> {
  const {
    resolved,
    branch,
    format = 'text',
    wireDepth,
    displayDepth = 'STANDARD',
    console,
  } = options;
  const { connection } = resolved;
  const files = resolveSqaaRunFiles(resolved.groups, displayBase);
  const isJson = format === 'json';

  const { result: tally, durationMs } = await timed(() =>
    runSqaaGroups(files.projects, connection, {
      branch,
      wireDepth,
      displayDepth,
      console,
      silent: isJson,
    }),
  );

  if (isJson) {
    const report = buildJsonReport(
      tally,
      ignored,
      files.displayPaths,
      displayBase,
      displayDepth,
      files.displayProjects,
    );
    await printSqaaJsonReport(report, connection, console);
  } else {
    if (tally.globalError instanceof SqaaForbiddenError) {
      await printVortexUnavailableForForbidden(connection, console);
    }
    const ignoredRows = ignored.map((f) => ({
      path: ignoredReportPath(f.path, displayBase),
      reason: f.reason,
    }));
    const repoRootFromCwd = repoRoot ? relative(process.cwd(), repoRoot) : undefined;
    printSqaaTextReport(
      {
        tally,
        allPaths: files.displayPaths,
        ignored: ignoredRows,
        projects: files.displayProjects,
        repoRootFromCwd,
        analysisDepth: displayDepth,
      },
      console,
    );
  }
  finishSqaaRun(tally, durationMs, options);
}
