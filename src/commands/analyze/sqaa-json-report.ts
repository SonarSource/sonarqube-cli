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

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { timed } from '@/core/observability/timed.ts';
import type { SonarConnection } from '@/core/server/connection.ts';

import { readSqaaFileContent } from './sqaa-api.ts';
import { prepareSqaaRun } from './sqaa-context.ts';
import {
  buildJsonReport,
  ignoredReportPath,
  makeReport,
  type SqaaJsonReport,
} from './sqaa-display.ts';
import { soleFile } from './sqaa-paths.ts';
import { fetchSingleFileReport, finishSqaaTelemetryFromReport, runSqaaGroups } from './sqaa-run.ts';
import type { AnalyzeSqaaOptions, AnalyzeSqaaRunOptions, PreparedSqaaRun } from './sqaa-types.ts';

type JsonReportRunOptions = AnalyzeSqaaRunOptions & { telemetryCtx: CommandInvocationContext };

async function buildSqaaJsonReportFromEntries(
  prepared: PreparedSqaaRun,
  runOptions: JsonReportRunOptions,
): Promise<SqaaJsonReport> {
  const { connection, files, branch, wireDepth, displayDepth, displayBase } = prepared;
  if (prepared.mode === 'single-file') {
    const { projectKey, file: path } = soleFile(files);
    const content = readSqaaFileContent(path.absolutePath);
    const { result, durationMs } = await timed(() =>
      fetchSingleFileReport(connection, projectKey, path, content, branch, wireDepth, displayDepth),
    );
    finishSqaaTelemetryFromReport(result.report, runOptions, durationMs);
    return result.report;
  }
  const { result: tally, durationMs } = await timed(() =>
    runSqaaGroups(files.projects, connection, {
      branch,
      wireDepth,
      displayDepth,
      console: runOptions.telemetryCtx.console,
      silent: true,
    }),
  );
  const report = buildJsonReport(
    tally,
    prepared.ignored,
    files.displayPaths,
    displayBase,
    displayDepth,
    files.displayProjects,
  );
  finishSqaaTelemetryFromReport(report, runOptions, durationMs);
  return report;
}

export async function buildSqaaJsonReport(
  options: AnalyzeSqaaOptions,
  connection: SonarConnection,
  runOptions: JsonReportRunOptions,
): Promise<SqaaJsonReport | null> {
  const prepared = await prepareSqaaRun(options, connection, runOptions.telemetryCtx.console, {
    requireProject: false,
    silentSkip: runOptions.silentSkip,
  });
  if (!prepared) return null;
  if (prepared.files.displayPaths.length === 0) {
    return makeReport(
      [],
      [],
      prepared.ignored.map((file) => ({
        path: ignoredReportPath(file.path, prepared.displayBase),
        reason: file.reason,
      })),
    );
  }
  return buildSqaaJsonReportFromEntries(prepared, {
    ...runOptions,
    auth: prepared.connection.auth,
  });
}
