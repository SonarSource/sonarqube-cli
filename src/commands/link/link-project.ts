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

import { join } from 'node:path';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { resolveGitRepoRoot } from '@/core/host/git/worktree.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import { cloudRegionFromUrl } from '@/core/server/sonarcloud-region.ts';
import {
  resolveContainedPath,
  type SharedProjectConfigEntry,
  sharedProjectConfigRepository,
} from '@/core/shared-project-config.ts';

export interface LinkOptions {
  path: string;
}

function deriveEntry(
  auth: ResolvedAuth,
  projectKey: string,
  path: string,
): SharedProjectConfigEntry {
  if (auth.connectionType !== 'cloud') {
    return { projectKey, path, serverUrl: auth.serverUrl };
  }

  const region = cloudRegionFromUrl(auth.serverUrl);
  if (!region || !auth.orgKey) {
    throw new CommandFailedError(
      'Could not determine the SonarQube Cloud region or organization for the active connection.',
      { remediationHint: "Run 'sonar auth login' to re-authenticate." },
    );
  }

  return { projectKey, path, region, organization: auth.orgKey };
}

export async function linkProject(
  projectKey: string,
  options: LinkOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth, console } = ctx;
  const { path } = options;

  if (path.trim().length === 0) {
    throw new CommandFailedError('--path must not be empty.', {
      remediationHint: "Use '--path .' for a project at the repository root.",
    });
  }

  const entry = deriveEntry(auth, projectKey, path);

  const cwd = process.cwd();
  const gitRoot = await resolveGitRepoRoot(cwd);
  const targetDir = canonicalizePath(gitRoot ?? cwd);

  // Validated — and any failure raised — before the no-git-repository warning below,
  // so a rejected path never gets the misleading "writing to cwd instead" message.
  const projectRoot = resolveContainedPath(targetDir, path);
  if (projectRoot === null) {
    throw new CommandFailedError(
      `--path "${path}" must point to an existing directory inside ${targetDir}.`,
      {
        remediationHint:
          'Use a path relative to the repository root, e.g. --path . or --path services/api.',
      },
    );
  }

  if (!gitRoot) {
    console.warn('No git repository found. Writing to the current directory instead.');
  }

  await sharedProjectConfigRepository.set(targetDir, entry);

  const configPath = join(targetDir, SHARED_PROJECT_CONFIG_FILE_NAME);
  const summaryLines = [
    `Linked ${projectRoot} to project ${projectKey}`,
    `Config saved to ${configPath}`,
  ];
  if (gitRoot) {
    summaryLines.push(`Commit ${SHARED_PROJECT_CONFIG_FILE_NAME} to share it.`);
  }
  console.success(summaryLines.join('\n'));
}
