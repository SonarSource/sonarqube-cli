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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import type { Console } from '@/core/ui/console.ts';

import {
  excludeIgnoredFiles,
  resolveChangeSet,
  resolveSqaaBranch,
  resolveSqaaBranchAtRepoRoot,
} from './sqaa-changeset.ts';
import {
  labelAnalysisDepth,
  parseSqaaDepthOption,
  resolveAnalysisDepth,
  type SqaaDeepWireDepth,
} from './sqaa-depth.ts';
import { resolveSqaaFileArgs } from './sqaa-file-arg.ts';
import { assertExplicitFilesAnalyzable, resolveSqaaRunFiles } from './sqaa-paths.ts';
import type { SqaaResolution } from './sqaa-resolution.ts';
import { confirmLargeChangeset } from './sqaa-resolution.ts';
import { resolveSqaaConnectionAndProject } from './sqaa-resolution.ts';
import type {
  AnalyzeSqaaOptions,
  AnalyzeSqaaRunOptions,
  OutputFormat,
  PreparedSqaaRun,
  SqaaResolvedRun,
} from './sqaa-types.ts';
import type { SqaaAnalysisDepth } from './sqaa-wire-types.ts';

/** Change-set size above which the user is prompted to confirm before proceeding. */
const SQAA_LARGE_CHANGESET_THRESHOLD = 50;

interface SqaaDepthResolution {
  wireDepth: SqaaDeepWireDepth | undefined;
  displayDepth: SqaaAnalysisDepth;
}

/**
 * Apply the command's policy to a connection/project resolution. This is where the
 * caller (not the resolver) decides what a missing project means:
 * - `requireProject` (explicit `analyze agentic` / `verify`): throw so the command
 *   exits with code 1 instead of skipping silently.
 * - otherwise (the bare `sonar analyze` catch-all): warn and return null so the
 *   surrounding command can proceed with its other analyses.
 *
 * A Cloud connection without an organization follows the same split: fatal when the user
 * named a project, a warning otherwise.
 */
export function resolveSqaaContext(
  resolution: SqaaResolution,
  policy: { requireProject: boolean; silentSkip?: boolean },
  console: Console,
): SqaaResolvedRun | null {
  switch (resolution.kind) {
    case 'resolved':
      return {
        connection: resolution.connection,
        groups: resolution.groups,
        ignored: resolution.ignored,
        projectRoots: resolution.projectRoots,
      };
    case 'no-org':
      if (resolution.explicitProject) {
        throw new CommandFailedError('Vortex analysis requires a SonarQube Cloud organization.', {
          remediationHint: "Run 'sonar auth login' and select an organization, then retry.",
        });
      }
      if (!policy.silentSkip) {
        console.warn(
          'Vortex analysis skipped: a SonarQube Cloud organization is required. Run: sonar auth login',
        );
      }
      return null;
    case 'no-project':
      if (policy.requireProject) {
        throw new CommandFailedError(
          'Vortex analysis requires a project, but none is configured for this directory.',
          {
            remediationHint:
              "Specify one with --project, or run 'sonar link <projectKey>' to link one to this repository.",
          },
        );
      }
      if (!policy.silentSkip) {
        console.warn(
          "Vortex analysis skipped: no project configured. Specify one with --project, or run 'sonar link <projectKey>' to link one to this repository.",
        );
      }
      return null;
  }
}

export function resolveDepthForMode(
  rawDepth: string | undefined,
  mode: 'single-file' | 'multi-file' | 'change-set',
  forcedDepth?: SqaaAnalysisDepth,
): SqaaDepthResolution {
  const explicitDepth = rawDepth === undefined ? undefined : parseSqaaDepthOption(rawDepth);
  const wireDepth = resolveAnalysisDepth(explicitDepth, mode, forcedDepth);
  return { wireDepth, displayDepth: labelAnalysisDepth(wireDepth) };
}

export async function confirmLargeRunIfNeeded(
  fileCount: number,
  console: Console,
  force?: boolean,
  format: OutputFormat = 'text',
): Promise<boolean> {
  if (!force && format !== 'json' && fileCount > SQAA_LARGE_CHANGESET_THRESHOLD) {
    return await confirmLargeChangeset(fileCount, console);
  }
  return true;
}

export async function prepareSqaaExplicitFiles(
  options: AnalyzeSqaaOptions,
  connection: SonarConnection,
  console: Console,
  policy: Pick<AnalyzeSqaaRunOptions, 'requireProject' | 'silentSkip'>,
): Promise<PreparedSqaaRun | null> {
  const entries = resolveSqaaFileArgs(options.file ?? []);
  const branch = await resolveSqaaBranch(options.branch, entries[0].absolutePath);
  const mode = entries.length === 1 ? 'single-file' : 'multi-file';
  const depth = resolveDepthForMode(options.depth, mode, options.forcedDepth);
  const resolution = await resolveSqaaConnectionAndProject(
    connection,
    options.project,
    console,
    entries.map((entry) => entry.absolutePath),
  );
  const resolved = resolveSqaaContext(
    resolution,
    { ...policy, requireProject: policy.requireProject ?? false },
    console,
  );
  if (!resolved) return null;
  assertExplicitFilesAnalyzable(resolved.ignored, resolved.projectRoots);
  if (!(await confirmLargeRunIfNeeded(entries.length, console, options.force, options.format)))
    return null;
  const displayBase = process.cwd();
  return {
    connection: resolved.connection,
    files: resolveSqaaRunFiles(resolved.groups, displayBase),
    mode,
    ignored: [],
    displayBase,
    branch,
    ...depth,
  };
}

export async function prepareSqaaRun(
  options: AnalyzeSqaaOptions,
  connection: SonarConnection,
  console: Console,
  policy: Pick<AnalyzeSqaaRunOptions, 'requireProject' | 'silentSkip'> = {},
): Promise<PreparedSqaaRun | null> {
  if (options.file?.length) return prepareSqaaExplicitFiles(options, connection, console, policy);
  const depth = resolveDepthForMode(options.depth, 'change-set', options.forcedDepth);
  let changeSet = await resolveChangeSet(process.cwd(), options);
  const branch = await resolveSqaaBranchAtRepoRoot(options.branch, changeSet.repoRoot);
  let files = resolveSqaaRunFiles([], changeSet.repoRoot);
  if (changeSet.files.length > 0) {
    const resolution = await resolveSqaaConnectionAndProject(
      connection,
      options.project,
      console,
      changeSet.files,
    );
    const resolved = resolveSqaaContext(
      resolution,
      { ...policy, requireProject: policy.requireProject ?? false },
      console,
    );
    if (!resolved) return null;
    connection = resolved.connection;
    changeSet = excludeIgnoredFiles(changeSet, resolved.ignored);
    files = resolveSqaaRunFiles(resolved.groups, changeSet.repoRoot);
    if (
      !(await confirmLargeRunIfNeeded(
        changeSet.files.length,
        console,
        options.force,
        options.format,
      ))
    )
      return null;
  }
  return {
    connection,
    files,
    mode: 'change-set',
    ignored: changeSet.ignored,
    displayBase: changeSet.repoRoot,
    repoRoot: changeSet.repoRoot,
    branch,
    ...depth,
    ...(files.displayPaths.length === 0 ? { displayDepth: 'STANDARD' as const } : {}),
  };
}
