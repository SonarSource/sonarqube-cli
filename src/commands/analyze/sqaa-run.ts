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
import type { Console } from '@/core/ui/console.ts';
import { vortexUnavailableCommandMessage } from '@/core/vortex/availability-messages.ts';
import { recheckVortexEntitlement } from '@/core/vortex/entitlement.ts';

import type { RunTally } from './sqaa-analysis.ts';
import { mergeTallies, runAnalyses } from './sqaa-analysis.ts';
import { recordSqaaAnalysisTelemetry } from './sqaa-analysis-telemetry.ts';
import { fetchWithRetry, MAX_503_RETRIES, readSqaaFileContent } from './sqaa-api.ts';
import { resolveSqaaBranch } from './sqaa-changeset.ts';
import { prepareSqaaRun } from './sqaa-context.ts';
import type { SqaaDeepWireDepth } from './sqaa-depth.ts';
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
import type {
  AnalyzeSqaaOptions,
  PreparedSqaaRun,
  SqaaPreparedRunOptions,
  SqaaProjectFiles,
} from './sqaa-types.ts';
import type { SqaaAnalysisDepth } from './sqaa-wire-types.ts';

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

export async function runSqaaGroups(
  projects: SqaaProjectFiles[],
  connection: SonarConnection,
  run: {
    branch: string | undefined;
    wireDepth: SqaaDeepWireDepth | undefined;
    displayDepth: SqaaAnalysisDepth;
    console: Console;
    silent: boolean;
    isTTY?: boolean;
  },
): Promise<RunTally> {
  const tallies: RunTally[] = [];
  for (const [index, { projectKey, files }] of projects.entries()) {
    const progress = new SqaaProgress({
      files: files.map((file) => file.displayPath),
      project: { key: projectKey, index: index + 1, total: projects.length },
      isTTY: run.isTTY,
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

async function fetchSingleFileTally(
  connection: SonarConnection,
  projectKey: string,
  path: SqaaPath,
  fileContent: string,
  branch?: string,
  wireDepth?: SqaaDeepWireDepth,
  onRetry?: (attempt: number) => Promise<void>,
): Promise<RunTally> {
  try {
    const response = await fetchWithRetry(
      connection,
      projectKey,
      { path: path.serverPath, content: fileContent },
      branch,
      { analysisDepth: wireDepth, onRetry },
    );
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
    completed = await executeSqaaRun(prepared, runOptions);
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

async function executeSqaaRun(
  prepared: PreparedSqaaRun,
  options: SqaaPreparedRunOptions,
): Promise<{ tally: RunTally; durationMs: number }> {
  const { connection, files, branch, wireDepth, displayDepth, mode } = prepared;
  let execute: () => Promise<RunTally>;
  if (mode === 'single-file' || mode === 'edited-file') {
    const { projectKey, file: path } = soleFile(files);
    const content = readSqaaFileContent(path.absolutePath);
    const singleBranch =
      mode === 'edited-file' ? await resolveSqaaBranch(undefined, path.absolutePath) : branch;
    const progress = new SqaaProgress({
      files: [path.displayPath],
      console: options.console,
      silent: options.format === 'json',
    });
    execute = () =>
      fetchSingleFileTally(
        connection,
        projectKey,
        path,
        content,
        singleBranch,
        wireDepth,
        (attempt) =>
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
    execute = () =>
      runSqaaGroups(files.projects, connection, {
        branch,
        wireDepth,
        displayDepth,
        console: options.console,
        silent: options.format === 'json',
      });
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
