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

import type { ResolvedAuth } from '../../../lib/auth-resolver.js';
import { timed } from '../../../lib/timed.js';
import type { SqaaAnalysisDepth } from '../../../sonarqube/client.js';
import {
  emitSqaaAnalysisTelemetry,
  type SqaaTelemetryCallerCommand,
  tallyFromSqaaJsonReport,
} from '../../../telemetry/sqaa-analysis-telemetry.js';
import { print } from '../../../ui';
import { SqaaProgress } from '../../../ui/components/sqaa-progress.js';
import type { RunContext, RunTally } from './sqaa-analysis.js';
import { runAnalyses } from './sqaa-analysis.js';
import { fetchWithRetry, readSqaaFileContent, toRelativePosixPath } from './sqaa-api.js';
import type { CloudAuth } from './sqaa-auth.js';
import { resolveCloudAuthAndProject } from './sqaa-auth.js';
import type { ChangeSetResult } from './sqaa-changeset.js';
import { resolveSqaaContext } from './sqaa-context.js';
import type { SqaaDeepWireDepth } from './sqaa-depth.js';
import {
  applyExitCode,
  displaySqaaResults,
  EXIT_CODE_ISSUES_FOUND,
  printJsonReport,
  printSingleFileTextFailure,
  printSqaaTextReport,
  singleFileFailureReport,
  singleFileSuccessReport,
  type SqaaJsonReport,
} from './sqaa-display.js';
import type { ResolvedSqaaFileEntry } from './sqaa-file-arg.js';
import type {
  AnalyzeSqaaRunOptions,
  SingleFileRunOptions,
  SqaaBatchRunOptions,
  SqaaResolvedContext,
} from './sqaa-types.js';

function resolveSqaaCommandExitCode(totalIssues: number, totalFailures: number): number {
  if (totalFailures > 0) return 1;
  if (totalIssues > 0) return EXIT_CODE_ISSUES_FOUND;
  return 0;
}

async function emitSqaaTelemetryIfRequested(
  telemetryCallerCommand: SqaaTelemetryCallerCommand | undefined,
  auth: ResolvedAuth,
  tally: RunTally,
  durationMs: number,
  exitCode: number,
): Promise<void> {
  if (!telemetryCallerCommand) return;
  await emitSqaaAnalysisTelemetry(telemetryCallerCommand, auth, tally, durationMs, exitCode);
}

export async function finishSqaaTelemetryFromReport(
  report: SqaaJsonReport,
  auth: ResolvedAuth,
  runOptions: AnalyzeSqaaRunOptions,
  durationMs: number,
): Promise<void> {
  if (!runOptions.telemetryCallerCommand) return;
  const exitCode =
    runOptions.telemetryProcessExitCode ??
    resolveSqaaCommandExitCode(report.summary.totalIssues, report.summary.totalFailures);
  await emitSqaaTelemetryIfRequested(
    runOptions.telemetryCallerCommand,
    auth,
    tallyFromSqaaJsonReport(report),
    durationMs,
    exitCode,
  );
}

async function finishSqaaRun(
  tally: RunTally,
  durationMs: number,
  options: SqaaBatchRunOptions,
): Promise<void> {
  const exitCode = resolveSqaaCommandExitCode(tally.totalIssues, tally.totalFailures);
  applyExitCode(tally.totalIssues, tally.totalFailures);
  await emitSqaaTelemetryIfRequested(
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

export async function runSqaaAnalysesTallyForResolved(
  files: string[],
  allPaths: string[],
  resolved: SqaaResolvedContext,
  branch: string | undefined,
  wireDepth: SqaaDeepWireDepth | undefined,
  displayDepth: SqaaAnalysisDepth,
  propagateForbiddenError?: boolean,
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
    propagateForbiddenError,
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
    return {
      report: singleFileFailureReport(filePath, error.message, displayDepth),
      error,
    };
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
  await emitSqaaTelemetryIfRequested(
    telemetryCallerCommand,
    auth,
    tallyFromSqaaJsonReport(report),
    durationMs,
    exitCode,
  );
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
    printJsonReport(tally, [], allPaths, cwd, displayDepth);
    await finishSqaaRun(tally, durationMs, options);
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
    await finishSqaaRun(tally, durationMs, options);
  } catch (err) {
    progress.finish();
    throw err;
  }
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
    printJsonReport(tally, ignored, allPaths, repoRoot, displayDepth);
    await finishSqaaRun(tally, durationMs, options);
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
    await finishSqaaRun(tally, durationMs, options);
  } catch (err) {
    progress.finish();
    throw err;
  }
}
