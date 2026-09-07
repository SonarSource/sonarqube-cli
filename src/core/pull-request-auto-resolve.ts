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

// Auto-resolves a pull request for the current git branch — shared by any command taking
// --branch/--pull-request (quality-gate status today, list issues potentially later).

import { resolveCurrentGitBranch } from '@/core/host/git/branch.ts';
import logger from '@/core/observability/logger.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { PullRequestsClient } from '@/core/server/pull-requests.ts';
import type { ProjectPullRequest } from '@/core/server/types.ts';

// Never throws — undefined (no git branch, lookup failed, no/ambiguous match) means the caller falls back to the default branch.
export async function autoResolvePullRequest(
  client: SonarHttpClient,
  projectKey: string,
): Promise<{ pullRequest: string; branch: string } | undefined> {
  const branch = await resolveCurrentGitBranch(process.cwd());
  if (!branch) {
    return undefined;
  }

  const pullRequests = await tryListPullRequests(client, projectKey);
  const matches = pullRequests?.filter((pr) => pr.branch === branch) ?? [];
  if (matches.length !== 1) {
    return undefined;
  }

  return { pullRequest: matches[0].key, branch };
}

async function tryListPullRequests(
  client: SonarHttpClient,
  projectKey: string,
): Promise<ProjectPullRequest[] | null> {
  try {
    return await new PullRequestsClient(client).listPullRequests(projectKey);
  } catch (err) {
    logger.debug(`Pull request auto-detection skipped for '${projectKey}'`, err);
    return null;
  }
}
