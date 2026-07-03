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
import { readSqaaFileContent, toRelativePosixPath } from './sqaa-api.js';
import { resolveCloudAuthAndProject } from './sqaa-auth.js';
import { resolveChangeSet } from './sqaa-changeset.js';
import {
  confirmLargeRunIfNeeded,
  resolveDepthForMode,
  resolveSqaaContext,
} from './sqaa-context.js';
import type { SqaaDeepWireDepth } from './sqaa-depth.js';
import { buildJsonReport, makeReport, type SqaaJsonReport } from './sqaa-display.js';
import { type ResolvedSqaaFileEntry, resolveSqaaFileArgs } from './sqaa-file-arg.js';
import {
  fetchSingleFileReport,
  finishSqaaTelemetryFromReport,
  runSqaaAnalysesTallyForResolved,
} from './sqaa-run.js';
import type {
  AnalyzeSqaaOptions,
  AnalyzeSqaaRunOptions,
  SqaaResolvedContext,
} from './sqaa-types.js';

async function buildSqaaJsonReportFromEntries(
  entries: ResolvedSqaaFileEntry[],
  resolved: SqaaResolvedContext,
  auth: ResolvedAuth,
  branch: string | undefined,
  wireDepth: SqaaDeepWireDepth | undefined,
  displayDepth: SqaaAnalysisDepth,
  runOptions: AnalyzeSqaaRunOptions,
): Promise<SqaaJsonReport> {
  if (entries.length === 1) {
    const { absolutePath } = entries[0];
    const fileContent = readSqaaFileContent(absolutePath);
    const { result: fetchResult, durationMs } = await timed(() =>
      fetchSingleFileReport(
        resolved.cloudAuth,
        resolved.projectKey,
        absolutePath,
        fileContent,
        branch,
        wireDepth,
        displayDepth,
      ),
    );
    await finishSqaaTelemetryFromReport(fetchResult.report, auth, runOptions, durationMs);
    return fetchResult.report;
  }

  const cwd = process.cwd();
  const absolutePaths = entries.map((e) => e.absolutePath);
  const allPaths = absolutePaths.map((f) => toRelativePosixPath(f, cwd));
  const { result: tally, durationMs } = await timed(() =>
    runSqaaAnalysesTallyForResolved(
      absolutePaths,
      allPaths,
      resolved,
      branch,
      wireDepth,
      displayDepth,
      runOptions.propagateForbiddenError,
    ),
  );
  const report = buildJsonReport(tally, [], allPaths, cwd, displayDepth);
  await finishSqaaTelemetryFromReport(report, auth, runOptions, durationMs);
  return report;
}

async function buildSqaaJsonReportFromChangeSet(
  options: AnalyzeSqaaOptions,
  auth: ResolvedAuth,
  rawDepth: string | undefined,
  forcedDepth: SqaaAnalysisDepth | undefined,
  runOptions: AnalyzeSqaaRunOptions,
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
  const { result: tally, durationMs } = await timed(() =>
    runSqaaAnalysesTallyForResolved(
      files,
      allPaths,
      resolved,
      branch,
      wireDepth,
      displayDepth,
      runOptions.propagateForbiddenError,
    ),
  );
  const report = buildJsonReport(tally, ignored, allPaths, repoRoot, displayDepth);
  await finishSqaaTelemetryFromReport(report, auth, runOptions, durationMs);
  return report;
}

/**
 * Run SQAA and return the JSON report without printing it.
 * Returns null when SQAA is not available (non-Cloud connection or no project configured).
 * Used by `analyzeAll` to build a combined JSON report.
 */
export async function buildSqaaJsonReport(
  options: AnalyzeSqaaOptions,
  auth: ResolvedAuth,
  runOptions: AnalyzeSqaaRunOptions = {},
): Promise<SqaaJsonReport | null> {
  const { file: rawFiles, branch, project, force, depth: rawDepth, forcedDepth } = options;

  if (rawFiles?.length) {
    const entries = resolveSqaaFileArgs(rawFiles);
    const resolution = await resolveCloudAuthAndProject(auth, project);
    const resolved = resolveSqaaContext(resolution, { requireProject: false });
    if (!resolved) return null;

    if (entries.length === 1) {
      const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'single-file', forcedDepth);
      return buildSqaaJsonReportFromEntries(
        entries,
        resolved,
        auth,
        branch,
        wireDepth,
        displayDepth,
        runOptions,
      );
    }

    const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'multi-file', forcedDepth);
    if (!(await confirmLargeRunIfNeeded(entries.length, force, options.format ?? 'text'))) {
      return null;
    }

    return buildSqaaJsonReportFromEntries(
      entries,
      resolved,
      auth,
      branch,
      wireDepth,
      displayDepth,
      runOptions,
    );
  }

  return buildSqaaJsonReportFromChangeSet(options, auth, rawDepth, forcedDepth, runOptions);
}
