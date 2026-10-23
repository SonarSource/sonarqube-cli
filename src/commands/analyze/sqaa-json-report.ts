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
import {
  type ChangeSetResult,
  excludeOutsideProjects,
  resolveChangeSet,
  resolveSqaaBranch,
  resolveSqaaBranchAtRepoRoot,
} from './sqaa-changeset.ts';
import {
  confirmLargeRunIfNeeded,
  resolveDepthForMode,
  resolveSqaaContext,
} from './sqaa-context.ts';
import type { SqaaDeepWireDepth } from './sqaa-depth.ts';
import {
  buildJsonReport,
  ignoredReportPath,
  makeReport,
  type SqaaJsonReport,
} from './sqaa-display.ts';
import { resolveSqaaFileArgs } from './sqaa-file-arg.ts';
import { assertInsideProjectRoots } from './sqaa-paths.ts';
import { resolveSqaaConnectionAndProject } from './sqaa-resolution.ts';
import {
  fetchSingleFileReport,
  finishSqaaTelemetryFromReport,
  resolveSqaaGroupPaths,
  runSqaaGroups,
} from './sqaa-run.ts';
import type { AnalyzeSqaaOptions, AnalyzeSqaaRunOptions, SqaaResolvedRun } from './sqaa-types.ts';
import type { SqaaAnalysisDepth } from './sqaa-wire-types.ts';

type JsonReportRunOptions = AnalyzeSqaaRunOptions & {
  telemetryCtx: CommandInvocationContext;
};

async function buildSqaaJsonReportFromEntries(
  resolved: SqaaResolvedRun,
  branch: string | undefined,
  wireDepth: SqaaDeepWireDepth | undefined,
  displayDepth: SqaaAnalysisDepth,
  runOptions: JsonReportRunOptions,
): Promise<SqaaJsonReport> {
  const cwd = process.cwd();
  const groupPaths = resolveSqaaGroupPaths(resolved.groups, cwd);
  const projects = groupPaths.map(({ group, paths }) => ({
    projectKey: group.projectKey,
    paths: paths.map((p) => p.displayPath),
  }));
  const allPaths = projects.flatMap(({ paths }) => paths);
  if (allPaths.length === 1) {
    const [{ group, paths }] = groupPaths;
    const [path] = paths;
    const fileContent = readSqaaFileContent(path.absolutePath);
    const { result: fetchResult, durationMs } = await timed(() =>
      fetchSingleFileReport(
        resolved.connection,
        group.projectKey,
        path,
        fileContent,
        branch,
        wireDepth,
        displayDepth,
      ),
    );
    finishSqaaTelemetryFromReport(fetchResult.report, runOptions, durationMs);
    return fetchResult.report;
  }

  const { result: tally, durationMs } = await timed(() =>
    runSqaaGroups(groupPaths, resolved.connection, {
      branch,
      wireDepth,
      displayDepth,
      console: runOptions.telemetryCtx.console,
      silent: true,
    }),
  );
  const report = buildJsonReport(tally, [], allPaths, cwd, displayDepth, projects);
  finishSqaaTelemetryFromReport(report, runOptions, durationMs);
  return report;
}

async function buildSqaaJsonReportFromChangeSet(
  options: AnalyzeSqaaOptions,
  connection: SonarConnection,
  rawDepth: string | undefined,
  forcedDepth: SqaaAnalysisDepth | undefined,
  runOptions: JsonReportRunOptions,
): Promise<SqaaJsonReport | null> {
  const { staged, base, branch, project, force } = options;
  const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'change-set', forcedDepth);

  const fullChangeSet = await resolveChangeSet(process.cwd(), { staged, base });
  const resolvedBranch = await resolveSqaaBranchAtRepoRoot(branch, fullChangeSet.repoRoot);
  if (fullChangeSet.files.length === 0) {
    return allExcludedReport(fullChangeSet);
  }

  const { console } = runOptions.telemetryCtx;
  const resolution = await resolveSqaaConnectionAndProject(
    connection,
    project,
    console,
    fullChangeSet.files,
  );
  const resolved = resolveSqaaContext(resolution, { requireProject: false }, console);
  if (!resolved) return null;

  const changeSet = excludeOutsideProjects(fullChangeSet, resolved.unmapped);
  if (changeSet.files.length === 0) {
    return allExcludedReport(changeSet);
  }

  if (
    !(await confirmLargeRunIfNeeded(
      changeSet.files.length,
      console,
      force,
      options.format ?? 'text',
    ))
  ) {
    return null;
  }

  const { ignored, repoRoot } = changeSet;
  const groupPaths = resolveSqaaGroupPaths(resolved.groups, repoRoot);
  const projects = groupPaths.map(({ group, paths }) => ({
    projectKey: group.projectKey,
    paths: paths.map((p) => p.displayPath),
  }));
  const allPaths = projects.flatMap(({ paths }) => paths);
  const { result: tally, durationMs } = await timed(() =>
    runSqaaGroups(groupPaths, resolved.connection, {
      branch: resolvedBranch,
      wireDepth,
      displayDepth,
      console,
      silent: true,
    }),
  );
  const report = buildJsonReport(tally, ignored, allPaths, repoRoot, displayDepth, projects);
  finishSqaaTelemetryFromReport(report, runOptions, durationMs);
  return report;
}

function allExcludedReport(changeSet: ChangeSetResult): SqaaJsonReport {
  return makeReport(
    [],
    [],
    changeSet.ignored.map((f) => ({
      path: ignoredReportPath(f.path, changeSet.repoRoot),
      reason: f.reason,
    })),
  );
}

/**
 * Run SQAA and return the JSON report without printing it.
 * Returns null when SQAA is not available (non-Cloud connection or no project configured).
 * Used by `analyzeAll` to build a combined JSON report.
 */
export async function buildSqaaJsonReport(
  options: AnalyzeSqaaOptions,
  connection: SonarConnection,
  runOptions: JsonReportRunOptions,
): Promise<SqaaJsonReport | null> {
  const telemetryOptions = { ...runOptions, auth: connection.auth };
  const { file: rawFiles, branch, project, force, depth: rawDepth, forcedDepth } = options;

  if (rawFiles?.length) {
    const entries = resolveSqaaFileArgs(rawFiles);
    const resolvedBranch = await resolveSqaaBranch(branch, entries[0].absolutePath);
    const { console } = runOptions.telemetryCtx;
    const resolution = await resolveSqaaConnectionAndProject(
      connection,
      project,
      console,
      entries.map((e) => e.absolutePath),
    );
    const resolved = resolveSqaaContext(resolution, { requireProject: false }, console);
    if (!resolved) return null;

    assertInsideProjectRoots(resolved.unmapped, resolved.projectRoots);
    if (entries.length === 1) {
      const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'single-file', forcedDepth);
      return buildSqaaJsonReportFromEntries(
        resolved,
        resolvedBranch,
        wireDepth,
        displayDepth,
        telemetryOptions,
      );
    }

    const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'multi-file', forcedDepth);
    if (
      !(await confirmLargeRunIfNeeded(entries.length, console, force, options.format ?? 'text'))
    ) {
      return null;
    }

    return buildSqaaJsonReportFromEntries(
      resolved,
      resolvedBranch,
      wireDepth,
      displayDepth,
      telemetryOptions,
    );
  }

  return buildSqaaJsonReportFromChangeSet(
    options,
    connection,
    rawDepth,
    forcedDepth,
    telemetryOptions,
  );
}
