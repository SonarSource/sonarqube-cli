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

import type { SqaaAnalysisDepth } from '../../sonarqube/client.ts';
import { warn } from '../../ui';
import { CommandFailedError } from '../_common/error.ts';
import type { SqaaAuthResolution } from './sqaa-auth.ts';
import { confirmLargeChangeset } from './sqaa-auth.ts';
import {
  labelAnalysisDepth,
  parseSqaaDepthOption,
  resolveAnalysisDepth,
  type SqaaDeepWireDepth,
} from './sqaa-depth.ts';
import type { OutputFormat, SqaaResolvedContext } from './sqaa-types.ts';

/** Change-set size above which the user is prompted to confirm before proceeding. */
const SQAA_LARGE_CHANGESET_THRESHOLD = 50;

interface SqaaDepthResolution {
  wireDepth: SqaaDeepWireDepth | undefined;
  displayDepth: SqaaAnalysisDepth;
}

/**
 * Apply the command's policy to an auth/project resolution. This is where the
 * caller (not the resolver) decides what a missing project means:
 * - `requireProject` (explicit `analyze agentic` / `verify`): throw so the command
 *   exits with code 1 instead of skipping silently.
 * - otherwise (the bare `sonar analyze` catch-all): warn and return null so the
 *   surrounding command can proceed with its other analyses.
 *
 * A non-Cloud connection is always a graceful skip (the warning was already emitted
 * by resolveCloudAuth), since agentic analysis is Cloud-only.
 */
export function resolveSqaaContext(
  resolution: SqaaAuthResolution,
  policy: { requireProject: boolean },
): SqaaResolvedContext | null {
  switch (resolution.kind) {
    case 'resolved':
      return { cloudAuth: resolution.cloudAuth, projectKey: resolution.projectKey };
    case 'no-cloud':
      return null;
    case 'no-project':
      if (policy.requireProject) {
        throw new CommandFailedError(
          'Vortex agentic analysis requires a project, but none is configured for this directory.',
          {
            remediationHint:
              "Specify one with --project, or run 'sonar integrate' to configure this project.",
          },
        );
      }
      warn(
        'Vortex agentic analysis skipped: no project configured. Specify one with --project or run: sonar integrate',
      );
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
  force?: boolean,
  format: OutputFormat = 'text',
): Promise<boolean> {
  if (!force && format !== 'json' && fileCount > SQAA_LARGE_CHANGESET_THRESHOLD) {
    return await confirmLargeChangeset(fileCount);
  }
  return true;
}
