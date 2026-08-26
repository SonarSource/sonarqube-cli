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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { timed } from '@/core/observability/timed.ts';
import type { SqaaAnalysisDepth } from '@/core/server/client.ts';
import { SqaaForbiddenError } from '@/core/server/errors.ts';
import { print } from '@/core/ui';
import { SqaaProgress } from '@/core/ui/components/sqaa-progress.ts';
import { vortexUnavailableCommandMessage } from '@/core/vortex/availability-messages.ts';
import { recheckVortexEntitlement } from '@/core/vortex/entitlement.ts';

import type { RunContext, RunTally } from './sqaa-analysis.ts';
import { runAnalyses } from './sqaa-analysis.ts';
import { recordSqaaAnalysisTelemetry, tallyFromSqaaJsonReport } from './sqaa-analysis-telemetry.ts';
import { fetchWithRetry, readSqaaFileContent, toRelativePosixPath } from './sqaa-api.ts';
import type { CloudAuth } from './sqaa-auth.ts';
import { resolveCloudAuthAndProject } from './sqaa-auth.ts';
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
import type {
  AnalyzeSqaaRunOptions,
  SingleFileRunOptions,
  SqaaBatchRunOptions,
  SqaaResolvedContext,
} from './sqaa-types.ts';

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
  const { telemetryCallerCommand, telemetryCtx } = runOptions;
  if (!telemetryCallerCommand || !telemetryCtx) return;
  const exitCode =
    runOptions.telemetryProcessExitCode ??
    resolveSqaaCommandExitCode(
      report.summary.totalIssues,
      report.summary.totalFailures,
      report.globalError !== undefined,
    );
  recordSqaaAnalysisTelemetry(
    telemetryCtx,
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
  auth: ResolvedAuth,
): Promise<void> {
  if (!report.globalError) return;
  const status = await recheckVortexEntitlement(auth);
  report.globalError = {
    ...report.globalError,
    message: vortexUnavailableCommandMessage(status),
  };
}

async function printVortexUnavailableForForbidden(auth: ResolvedAuth): Promise<void> {
  printVortexUnavailable(await recheckVortexEntitlement(auth));
}

async function printSqaaJsonReport(report: SqaaJsonReport, auth: ResolvedAuth): Promise<void> {
  if (report.globalError?.kind === 'forbidden') {
    await enrichForbiddenGlobalError(report, auth);
  }
  print(JSON.stringify(report, null, 2));
}

function displaySingleFileReport(report: SqaaJsonReport, displayDepth: SqaaAnalysisDepth): void {
  const file = report.files[0];
  displaySqaaResults(file.issues, file.errors, file.path, displayDepth);
}

export async function runSqaaAnalysesTallyForResolved(
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

export async function fetchSingleFileReport(
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

export async function runSqaaAnalysis(
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
    telemetryCtx,
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
    await printSqaaJsonReport(report, auth);
  } else if (error instanceof SqaaForbiddenError) {
    await printVortexUnavailableForForbidden(auth);
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
  if (telemetryCallerCommand && telemetryCtx) {
    recordSqaaAnalysisTelemetry(
      telemetryCtx,
      telemetryCallerCommand,
      tallyFromSqaaJsonReport(report),
      durationMs,
      exitCode,
    );
  }
}

export async function runSqaaAnalysisOnExplicitFiles(
  entries: ResolvedSqaaFileEntry[],
  options: SqaaBatchRunOptions,
): Promise<void> {
  const { resolved, branch, format = 'text', wireDepth, displayDepth = 'STANDARD' } = options;
  const cwd = process.cwd();
  const files = entries.map((e) => e.absolutePath);
  const allPaths = files.map((f) => toRelativePosixPath(f, cwd));

  if (format === 'json') {
    const { result: tally, durationMs } = await timed(() =>
      runSqaaAnalysesTallyForResolved(files, allPaths, resolved, branch, wireDepth, displayDepth),
    );
    const report = buildJsonReport(tally, [], allPaths, cwd, displayDepth);
    await printSqaaJsonReport(report, options.auth);
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
  const { result: tally, durationMs } = await timed(() => runAnalyses(ctx));
  progress.finish();
  if (tally.globalError instanceof SqaaForbiddenError) {
    await printVortexUnavailableForForbidden(options.auth);
  }
  printSqaaTextReport({ tally, allPaths, ignoredPaths: [], analysisDepth: displayDepth });
  finishSqaaRun(tally, durationMs, options);
}

export async function runSqaaAnalysisOnFiles(
  changeSet: ChangeSetResult,
  options: SqaaBatchRunOptions,
): Promise<void> {
  const { resolved, branch, format = 'text', wireDepth, displayDepth = 'STANDARD' } = options;
  const { files, ignored, repoRoot } = changeSet;
  const { cloudAuth, projectKey } = resolved;
  const allPaths = files.map((f) => toRelativePosixPath(f, repoRoot));

  if (format === 'json') {
    const { result: tally, durationMs } = await timed(() =>
      runSqaaAnalysesTallyForResolved(files, allPaths, resolved, branch, wireDepth, displayDepth),
    );
    const report = buildJsonReport(tally, ignored, allPaths, repoRoot, displayDepth);
    await printSqaaJsonReport(report, options.auth);
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
  const { result: tally, durationMs } = await timed(() => runAnalyses(ctx));
  progress.finish();
  if (tally.globalError instanceof SqaaForbiddenError) {
    await printVortexUnavailableForForbidden(options.auth);
  }
  printSqaaTextReport({ tally, allPaths, ignoredPaths, analysisDepth: displayDepth });
  finishSqaaRun(tally, durationMs, options);
}
