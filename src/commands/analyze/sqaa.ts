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
import { InvalidOptionError } from '@/core/command-error.ts';
import type { SqaaAnalysisDepth } from '@/core/server/client.ts';
import { text } from '@/core/ui';

import { resolveCloudAuthAndProject } from './sqaa-auth.ts';
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

export { buildSqaaJsonReport } from './sqaa-json-report.ts';
export {
  type AnalyzeSqaaOptions,
  type AnalyzeSqaaRunOptions,
  type OutputFormat,
  VALID_FORMATS,
} from './sqaa-types.ts';

export async function analyzeSqaa(
  options: AnalyzeSqaaOptions,
  auth: ResolvedAuth,
  runOptions: AnalyzeSqaaRunOptions = {},
): Promise<void> {
  const { requireProject = true, telemetryCallerCommand } = runOptions;
  const {
    file: rawFiles,
    staged,
    base,
    branch,
    project,
    force,
    format = 'text',
    depth: rawDepth,
    forcedDepth,
  } = options;

  if (staged && base !== undefined) {
    throw new InvalidOptionError('--staged and --base cannot be used together');
  }

  if (rawFiles?.length) {
    await analyzeSqaaExplicitFiles(rawFiles, {
      auth,
      branch,
      project,
      force,
      format,
      rawDepth,
      forcedDepth,
      requireProject,
      telemetryCallerCommand,
    });
    return;
  }

  await analyzeSqaaChangeSet({
    auth,
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
  });
}

async function analyzeSqaaExplicitFiles(
  rawFiles: string[],
  params: {
    auth: ResolvedAuth;
    branch?: string;
    project?: string;
    force?: boolean;
    format: OutputFormat;
    rawDepth?: string;
    forcedDepth?: SqaaAnalysisDepth;
    requireProject: boolean;
    telemetryCallerCommand: SqaaBatchRunOptions['telemetryCallerCommand'];
  },
): Promise<void> {
  const entries = resolveSqaaFileArgs(rawFiles);
  const {
    auth,
    branch,
    project,
    force,
    format,
    rawDepth,
    forcedDepth,
    requireProject,
    telemetryCallerCommand,
  } = params;
  const resolvedBranch = await resolveSqaaBranch(branch, entries[0].absolutePath);

  if (entries.length === 1) {
    const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'single-file', forcedDepth);
    await runSqaaAnalysis(entries[0].absolutePath, auth, {
      branch: resolvedBranch,
      explicitProject: project,
      format,
      requireProject,
      wireDepth,
      displayDepth,
      telemetryCallerCommand,
    });
    return;
  }

  const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'multi-file', forcedDepth);
  const resolution = await resolveCloudAuthAndProject(auth, project);
  const resolved = resolveSqaaContext(resolution, { requireProject });
  if (!resolved) return;

  if (!(await confirmLargeRunIfNeeded(entries.length, force, format))) return;

  await runSqaaAnalysisOnExplicitFiles(entries, {
    resolved,
    auth,
    branch: resolvedBranch,
    format,
    wireDepth,
    displayDepth,
    telemetryCallerCommand,
  });
}

async function analyzeSqaaChangeSet(params: {
  auth: ResolvedAuth;
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
}): Promise<void> {
  const {
    auth,
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
  } = params;
  const { wireDepth, displayDepth } = resolveDepthForMode(rawDepth, 'change-set', forcedDepth);

  const changeSet = await resolveChangeSet(process.cwd(), { staged, base });
  const resolvedBranch = await resolveSqaaBranchAtRepoRoot(branch, changeSet.repoRoot);

  if (changeSet.files.length === 0 && changeSet.ignored.length === 0) {
    text('Vortex analysis: no files in the change set to analyze.');
    return;
  }

  if (changeSet.files.length === 0) {
    text(
      'Vortex analysis: no files to analyze — all change set files were excluded (binary or oversized).',
    );
    return;
  }

  const resolution = await resolveCloudAuthAndProject(auth, project, changeSet.repoRoot);
  const resolved = resolveSqaaContext(resolution, { requireProject });
  if (!resolved) return;

  if (!(await confirmLargeRunIfNeeded(changeSet.files.length, force, format))) return;

  await runSqaaAnalysisOnFiles(changeSet, {
    resolved,
    auth,
    branch: resolvedBranch,
    format,
    wireDepth,
    displayDepth,
    telemetryCallerCommand,
  });
}
