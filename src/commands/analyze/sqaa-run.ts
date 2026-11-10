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

import { getSqaaRetry503BaseDelayMs } from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';
import { timed } from '@/core/observability/timed.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { SqaaForbiddenError } from '@/core/server/errors.ts';
import { vortexUnavailableCommandMessage } from '@/core/vortex/availability-messages.ts';
import { recheckVortexEntitlement } from '@/core/vortex/entitlement.ts';

import type { RunTally } from './sqaa-analysis.ts';
import { executePreparedAnalyses, mergeTallies } from './sqaa-analysis.ts';
import { recordSqaaAnalysisTelemetry } from './sqaa-analysis-telemetry.ts';
import { fetchPreparedSqaaWithRetry, MAX_503_RETRIES } from './sqaa-api.ts';
import { prepareSqaaRun } from './sqaa-context.ts';
import {
  buildJsonReport,
  displaySqaaResults,
  ignoredReportPath,
  printSingleFileTextFailure,
  printSqaaTextReport,
  printVortexUnavailable,
  resolveSqaaCommandExitCode,
  type SqaaJsonReport,
} from './sqaa-display.ts';
import { isGlobalSqaaError } from './sqaa-errors.ts';
import { soleFile, type SqaaPath, withDisplayFilePath } from './sqaa-paths.ts';
import { SqaaProgress } from './sqaa-progress.ts';
import {
  type PreparedSqaaAnalysis,
  type PreparedSqaaProject,
  prepareSqaaRequests,
} from './sqaa-request.ts';
import type {
  AnalyzeSqaaOptions,
  PreparedSqaaRun,
  SqaaPreparedRunOptions,
  SqaaProjectFiles,
} from './sqaa-types.ts';

export async function enrichForbiddenGlobalError(
  report: SqaaJsonReport,
  connection: SonarConnection,
): Promise<void> {
  if (report.globalError?.kind !== 'forbidden') return;
  const status = await recheckVortexEntitlement(connection);
  report.globalError = {
    ...report.globalError,
    message: vortexUnavailableCommandMessage(status),
  };
}

async function executeSqaaGroups(
  projects: SqaaProjectFiles[],
  requests: PreparedSqaaProject[],
  connection: SonarConnection,
  options: SqaaPreparedRunOptions,
): Promise<RunTally> {
  const tallies: RunTally[] = [];
  for (const [index, { projectKey, files }] of projects.entries()) {
    const progress = new SqaaProgress({
      files: files.map((file) => file.displayPath),
      project: { key: projectKey, index: index + 1, total: projects.length },
      silent: options.format === 'json',
      console: options.console,
    });
    const tally = await executePreparedAnalyses(
      {
        paths: files,
        connection,
        progress,
      },
      requests[index],
    );
    progress.finish();
    tallies.push(tally);
    if (tally.globalError) break;
  }
  return mergeTallies(tallies);
}

async function fetchSingleFileTally(
  connection: SonarConnection,
  prepared: PreparedSqaaProject,
  path: SqaaPath,
  onRetry?: (attempt: number) => Promise<void>,
): Promise<RunTally> {
  try {
    if (prepared.failures.length > 0) throw prepared.failures[0].failure;
    const response = await fetchPreparedSqaaWithRetry(connection, prepared.payload, onRetry);
    const issues = withDisplayFilePath(response.issues, path.displayPath);
    return {
      allResults: [
        { file: path.absolutePath, filePath: path.displayPath, issues, errors: response.errors },
      ],
      totalIssues: issues.length,
      totalErrors: response.errors?.length ?? 0,
      totalFailures: 0,
    };
  } catch (err) {
    const error = err as Error;
    return {
      allResults: [{ file: path.absolutePath, filePath: path.displayPath, failure: error }],
      totalIssues: 0,
      totalErrors: 0,
      totalFailures: 1,
      ...(isGlobalSqaaError(error) ? { globalError: error } : {}),
    };
  }
}

export async function runSqaaAnalysis(
  options: AnalyzeSqaaOptions,
  connection: SonarConnection,
  runOptions: SqaaPreparedRunOptions,
): Promise<{ prepared: PreparedSqaaRun; tally: RunTally; durationMs: number } | null> {
  const prepared = await prepareSqaaRun(options, connection, runOptions.console, runOptions);
  if (!prepared) return null;
  if (prepared.files.displayPaths.length === 0)
    return { prepared, tally: mergeTallies([]), durationMs: 0 };
  const start = performance.now();
  let completed: { tally: RunTally; durationMs: number } | undefined;
  try {
    completed = await executeSqaaRun(await prepareSqaaRequests(prepared), runOptions);
  } catch (err) {
    if (runOptions.onExecutionError !== 'record-and-skip') throw err;
    logger.debug(`Vortex analysis failed: ${(err as Error).message}`);
  }
  const { tally, durationMs } = completed ?? {
    tally: { allResults: [], totalIssues: 0, totalErrors: 0, totalFailures: 1 },
    durationMs: Math.round(performance.now() - start),
  };
  if (runOptions.telemetryCallerCommand && runOptions.telemetryCtx) {
    recordSqaaAnalysisTelemetry(
      runOptions.telemetryCtx,
      prepared.connection.auth,
      runOptions.telemetryCallerCommand,
      tally,
      durationMs,
      runOptions.telemetryProcessExitCode ??
        resolveSqaaCommandExitCode(
          tally.totalIssues,
          tally.totalFailures,
          tally.globalError !== undefined,
        ),
    );
  }
  return completed ? { prepared, tally, durationMs } : null;
}

export async function executeSqaaRun(
  prepared: PreparedSqaaAnalysis,
  options: SqaaPreparedRunOptions,
): Promise<{ tally: RunTally; durationMs: number }> {
  const { connection, files, mode } = prepared.run;
  let execute: () => Promise<RunTally>;
  if (mode === 'single-file' || mode === 'edited-file') {
    const { file: path } = soleFile(files);
    const progress = new SqaaProgress({
      files: [path.displayPath],
      console: options.console,
      silent: options.format === 'json',
    });
    execute = () =>
      fetchSingleFileTally(connection, prepared.projects[0], path, (attempt) =>
        progress.retryingChunk(
          0,
          attempt,
          MAX_503_RETRIES,
          getSqaaRetry503BaseDelayMs() * 2 ** (attempt - 1),
        ),
      ).finally(() => {
        progress.finish();
      });
  } else {
    execute = () => executeSqaaGroups(files.projects, prepared.projects, connection, options);
  }
  const { result: tally, durationMs } = await timed(execute);
  return { tally, durationMs };
}

export function buildSqaaRunReport(prepared: PreparedSqaaRun, tally: RunTally): SqaaJsonReport {
  return buildJsonReport(
    tally,
    prepared.ignored,
    prepared.files.displayPaths,
    prepared.displayBase,
    prepared.displayDepth,
    prepared.files.displayProjects,
  );
}

export async function presentSqaaRun(
  prepared: PreparedSqaaRun,
  tally: RunTally,
  options: SqaaPreparedRunOptions,
): Promise<void> {
  const { connection, files, displayDepth } = prepared;
  const { console } = options;
  if (options.format === 'json') {
    const report = buildSqaaRunReport(prepared, tally);
    await enrichForbiddenGlobalError(report, connection);
    console.print(JSON.stringify(report, null, 2));
    return;
  }
  if (tally.globalError instanceof SqaaForbiddenError) {
    printVortexUnavailable(await recheckVortexEntitlement(connection), console);
    if (prepared.mode === 'single-file') return;
  }
  if (prepared.mode === 'single-file') {
    const result = tally.allResults[0];
    if ('failure' in result)
      printSingleFileTextFailure(result.filePath, result.failure, console, displayDepth);
    else displaySqaaResults(result.issues, result.errors, result.filePath, console, displayDepth);
    return;
  }
  printSqaaTextReport(
    {
      tally,
      allPaths: files.displayPaths,
      ignored: prepared.ignored.map((file) => ({
        path: ignoredReportPath(file.path, prepared.displayBase),
        reason: file.reason,
      })),
      projects: files.displayProjects,
      repoRootFromCwd: prepared.repoRoot ? relative(process.cwd(), prepared.repoRoot) : undefined,
      analysisDepth: displayDepth,
    },
    console,
  );
}
