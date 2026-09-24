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

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import type {
  CommandAuthenticatedInvocationContext,
  CommandInvocationContext,
} from '@/core/commands/invocation-context.ts';
import { resolveFormatOption } from '@/core/commands/parsing.ts';
import type { SonarConnection } from '@/core/server/connection.ts';

import {
  resolveChangeSet,
  resolveSqaaBranch,
  resolveSqaaBranchAtRepoRoot,
} from './sqaa-changeset.ts';
import {
  confirmLargeRunIfNeeded,
  resolveDepthForMode,
  resolveSqaaContext,
} from './sqaa-context.ts';
import { resolveSqaaFileArgs } from './sqaa-file-arg.ts';
import { resolveSqaaConnectionAndProject } from './sqaa-resolution.ts';
import {
  runSqaaAnalysis,
  runSqaaAnalysisOnExplicitFiles,
  runSqaaAnalysisOnFiles,
} from './sqaa-run.ts';
import type {
  AnalyzeSqaaOptions,
  AnalyzeSqaaRunOptions,
  OutputFormat,
  SqaaBatchRunOptions,
} from './sqaa-types.ts';
import { VALID_FORMATS } from './sqaa-types.ts';
import type { SqaaAnalysisDepth } from './sqaa-wire-types.ts';

export { buildSqaaJsonReport } from './sqaa-json-report.ts';
export {
  type AnalyzeSqaaOptions,
  type AnalyzeSqaaRunOptions,
  type OutputFormat,
  VALID_FORMATS,
} from './sqaa-types.ts';

export async function analyzeSqaa(
  options: AnalyzeSqaaOptions,
  ctx: CommandAuthenticatedInvocationContext,
  runOptions: AnalyzeSqaaRunOptions = {},
): Promise<void> {
  const { connection } = ctx;
  const { requireProject = true, telemetryCallerCommand } = runOptions;
  const telemetryCtx = runOptions.telemetryCtx ?? ctx;
  const {
    file: rawFiles,
    staged,
    base,
    branch,
    project,
    force,
    format: rawFormat,
    depth: rawDepth,
    forcedDepth,
  } = options;
  const format = resolveFormatOption(rawFormat, VALID_FORMATS, 'text');

  if (staged && base !== undefined) {
    throw new InvalidOptionError('--staged and --base cannot be used together');
  }

  if (rawFiles?.length) {
    await analyzeSqaaExplicitFiles(rawFiles, {
      connection,
      branch,
      project,
      force,
      format,
      rawDepth,
      forcedDepth,
      requireProject,
      telemetryCallerCommand,
      telemetryCtx,
    });
    return;
  }

  await analyzeSqaaChangeSet({
    connection,
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
    telemetryCtx,
  });
}

async function analyzeSqaaExplicitFiles(
  rawFiles: string[],
  params: {
    connection: SonarConnection;
    branch?: string;
    project?: string;
    force?: boolean;
    format: OutputFormat;
    rawDepth?: string;
    forcedDepth?: SqaaAnalysisDepth;
    requireProject: boolean;
    telemetryCallerCommand: SqaaBatchRunOptions['telemetryCallerCommand'];
    telemetryCtx: CommandInvocationContext;
  },
): Promise<void> {
  const entries = resolveSqaaFileArgs(rawFiles);
  const {
    connection,
    branch,
    project,
    force,
    format,
    rawDepth,
    forcedDepth,
    requireProject,
    telemetryCallerCommand,
    telemetryCtx,
  } = params;
  const { console } = telemetryCtx;
  const resolvedBranch = await resolveSqaaBranch(branch, entries[0].absolutePath);

  if (entries.length === 1) {
    const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'single-file', forcedDepth);
    await runSqaaAnalysis(entries[0].absolutePath, {
      connection,
      branch: resolvedBranch,
      explicitProject: project,
      format,
      requireProject,
      wireDepth,
      displayDepth,
      telemetryCallerCommand,
      telemetryCtx,
      console,
    });
    return;
  }

  const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'multi-file', forcedDepth);
  const resolution = await resolveSqaaConnectionAndProject(connection, project, console);
  const resolved = resolveSqaaContext(resolution, { requireProject }, console);
  if (!resolved) return;

  if (!(await confirmLargeRunIfNeeded(entries.length, console, force, format))) return;

  await runSqaaAnalysisOnExplicitFiles(entries, {
    resolved,
    branch: resolvedBranch,
    format,
    wireDepth,
    displayDepth,
    telemetryCallerCommand,
    telemetryCtx,
    console,
  });
}

async function analyzeSqaaChangeSet(params: {
  connection: SonarConnection;
  staged?: boolean;
  base?: string;
  branch?: string;
  project?: string;
  force?: boolean;
  format: OutputFormat;
  rawDepth?: string;
  forcedDepth?: SqaaAnalysisDepth;
  requireProject: boolean;
  telemetryCallerCommand: SqaaBatchRunOptions['telemetryCallerCommand'];
  telemetryCtx: CommandInvocationContext;
}): Promise<void> {
  const {
    connection,
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
    telemetryCtx,
  } = params;
  const { console } = telemetryCtx;
  const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'change-set', forcedDepth);

  const changeSet = await resolveChangeSet(process.cwd(), { staged, base });
  const resolvedBranch = await resolveSqaaBranchAtRepoRoot(branch, changeSet.repoRoot);

  if (changeSet.files.length === 0 && changeSet.ignored.length === 0) {
    console.text('Vortex analysis: no files in the change set to analyze.');
    return;
  }

  if (changeSet.files.length === 0) {
    console.text(
      'Vortex analysis: no files to analyze — all change set files were excluded (binary, oversized, or outside the repository).',
    );
    return;
  }

  const resolution = await resolveSqaaConnectionAndProject(
    connection,
    project,
    console,
    changeSet.repoRoot,
  );
  const resolved = resolveSqaaContext(resolution, { requireProject }, console);
  if (!resolved) return;

  if (!(await confirmLargeRunIfNeeded(changeSet.files.length, console, force, format))) return;

  await runSqaaAnalysisOnFiles(changeSet, {
    resolved,
    branch: resolvedBranch,
    format,
    wireDepth,
    displayDepth,
    telemetryCallerCommand,
    telemetryCtx,
    console,
  });
}
