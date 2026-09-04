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

import type { CommandAuthenticatedInvocationContext } from '@/commands/command-invocation-context.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { findGitRoot } from '@/core/host/git/discover.ts';
import { cloudRegionFromUrl } from '@/core/server/sonarcloud-region.ts';
import {
  type SharedProjectConfigEntryInput,
  type SharedProjectConfigRepository,
  SharedProjectConfigRepositoryImpl,
} from '@/core/shared-project-config.ts';
import { success } from '@/core/ui';

export interface LinkOptions {
  project: string;
  path: string;
}

const sharedProjectConfigRepository: SharedProjectConfigRepository =
  new SharedProjectConfigRepositoryImpl();

function deriveEntryFromAuth(
  auth: ResolvedAuth,
  projectKey: string,
  path: string,
): SharedProjectConfigEntryInput {
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

export async function link(
  options: LinkOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const entry = deriveEntryFromAuth(ctx.auth, options.project, options.path);

  const { gitRoot, isGit } = findGitRoot(process.cwd());
  if (!isGit) {
    throw new CommandFailedError('No git repository found.', {
      remediationHint: 'Run sonar link from inside a git repository.',
    });
  }

  await sharedProjectConfigRepository.set(gitRoot, entry);
  success(`Added ${options.project} to ${SHARED_PROJECT_CONFIG_FILE_NAME}.`);
}
