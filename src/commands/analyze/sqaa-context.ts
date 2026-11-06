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
import { canonicalizePath, toRelativePosixPath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import type { Console } from '@/core/ui/console.ts';

import {
  type IgnoredFile,
  resolveChangeSet,
  resolveSqaaBranch,
  resolveSqaaBranchAtRepoRoot,
} from './sqaa-changeset.ts';
import {
  labelAnalysisDepth,
  parseSqaaDepthOption,
  resolveAnalysisDepth,
  type SqaaInvocationMode,
} from './sqaa-depth.ts';
import { resolveSqaaFileArgs } from './sqaa-file-arg.ts';
import { assertExplicitFilesAnalyzable, resolveSqaaRunFiles } from './sqaa-paths.ts';
import {
  confirmLargeChangeset,
  resolveSqaaConnectionAndProject,
  type SqaaResolution,
} from './sqaa-resolution.ts';
import type {
  AnalyzeSqaaOptions,
  AnalyzeSqaaRunOptions,
  OutputFormat,
  PreparedSqaaRun,
  SqaaProjectGroup,
  SqaaResolvedRun,
} from './sqaa-types.ts';

/** Change-set size above which the user is prompted to confirm before proceeding. */
const SQAA_LARGE_CHANGESET_THRESHOLD = 50;

type SqaaPreparationPolicy = Pick<
  AnalyzeSqaaRunOptions,
  'requireProject' | 'silentSkip' | 'noteFocusedProject'
>;

interface SqaaTarget {
  mode: SqaaInvocationMode;
  files: string[];
  repoRoot?: string;
  branch?: string;
  ignored: IgnoredFile[];
  check: (resolved: SqaaResolvedRun) => boolean;
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

async function explicitFilesTarget(options: AnalyzeSqaaOptions): Promise<SqaaTarget> {
  const entries = resolveSqaaFileArgs(options.file ?? []);
  return {
    mode: entries.length === 1 ? 'single-file' : 'multi-file',
    files: entries.map((entry) => entry.absolutePath),
    branch: await resolveSqaaBranch(options.branch, entries[0].absolutePath),
    ignored: [],
    check: (resolved) => {
      assertExplicitFilesAnalyzable(resolved.ignored, resolved.projectRoots);
      return true;
    },
  };
}

async function changeSetTarget(options: AnalyzeSqaaOptions): Promise<SqaaTarget> {
  const changeSet = await resolveChangeSet(process.cwd(), options);
  return {
    ...changeSet,
    mode: 'change-set',
    branch: await resolveSqaaBranchAtRepoRoot(options.branch, changeSet.repoRoot),
    check: () => true,
  };
}

function editedFileTarget(file: string): SqaaTarget | null {
  const canonicalPath = canonicalizePath(file);
  if (toRelativePosixPath(canonicalPath) === null) {
    logger.debug(`PostToolUse SQAA skipped: file outside cwd: ${file}`);
    return null;
  }
  return {
    mode: 'edited-file',
    files: [canonicalPath],
    ignored: [],
    check: (resolved) => resolved.groups.length > 0,
  };
}

export async function prepareSqaaRun(
  options: AnalyzeSqaaOptions,
  connection: SonarConnection,
  console: Console,
  policy: SqaaPreparationPolicy = {},
): Promise<PreparedSqaaRun | null> {
  const explicitDepth =
    options.depth === undefined ? undefined : parseSqaaDepthOption(options.depth);
  let target: SqaaTarget | null;
  if (options.editedFile === undefined) {
    target = await (options.file?.length ? explicitFilesTarget(options) : changeSetTarget(options));
  } else {
    target = editedFileTarget(options.editedFile);
  }
  if (!target) return null;
  const { files: inputFiles, check, ...run } = target;
  const wireDepth = resolveAnalysisDepth(explicitDepth, run.mode, options.forcedDepth);
  const displayBase = run.repoRoot ?? process.cwd();
  let groups: SqaaProjectGroup[] = [];
  let ignored = run.ignored;
  if (inputFiles.length > 0) {
    const resolution = await resolveSqaaConnectionAndProject(
      connection,
      options.project,
      console,
      inputFiles,
      { noteFocusedProject: policy.noteFocusedProject },
    );
    const resolved = resolveSqaaContext(
      resolution,
      { ...policy, requireProject: policy.requireProject ?? false },
      console,
    );
    if (!resolved || !check(resolved)) return null;
    connection = resolved.connection;
    groups = resolved.groups;
    ignored = [...ignored, ...resolved.ignored];
    const fileCount = groups.reduce((count, group) => count + group.files.length, 0);
    if (!(await confirmLargeRunIfNeeded(fileCount, console, options.force, options.format)))
      return null;
  }
  const files = resolveSqaaRunFiles(groups, displayBase);
  return {
    ...run,
    connection,
    files,
    ignored,
    displayBase,
    ...(wireDepth === undefined ? {} : { wireDepth }),
    displayDepth: files.displayPaths.length === 0 ? 'STANDARD' : labelAnalysisDepth(wireDepth),
  };
}
