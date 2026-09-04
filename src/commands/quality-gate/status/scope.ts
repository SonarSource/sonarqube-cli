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

// Resolves which branch or pull request `quality-gate status` reports on

import { CommandFailedError, InvalidOptionError } from '@/core/command-error.ts';
import { resolveCurrentGitBranch } from '@/core/host/git/branch.ts';
import logger from '@/core/observability/logger.ts';
import { BranchesClient } from '@/core/server/branches.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { PullRequestsClient } from '@/core/server/pull-requests.ts';

export interface QualityGateStatusScopeOptions {
  branch?: string;
  pullRequest?: string;
}

// `default`/`pullRequestAuto` mark values resolved automatically rather than given explicitly,
// for display ("Branch main (default)" / "Pull Request 42 (auto-detected...)").
export type QualityGateScopeKind = 'branch' | 'pullRequest' | 'pullRequestAuto' | 'default';

export interface QualityGateScope {
  kind: QualityGateScopeKind;
  value: string;
  /** Set only for `pullRequestAuto` — the git branch the PR was matched against. */
  detectedFromBranch?: string;
}

export interface QualityGateResolvedScope {
  queryParams: { branch?: string; pullRequest?: string };
  scope: QualityGateScope;
}

export async function resolveQualityGateScope(
  client: SonarHttpClient,
  projectKey: string,
  options: QualityGateStatusScopeOptions,
): Promise<QualityGateResolvedScope> {
  if (options.branch && options.pullRequest) {
    throw new InvalidOptionError('--branch and --pull-request cannot be used together.');
  }
  if (options.pullRequest) {
    return {
      queryParams: { pullRequest: options.pullRequest },
      scope: { kind: 'pullRequest', value: options.pullRequest },
    };
  }
  if (options.branch) {
    return {
      queryParams: { branch: options.branch },
      scope: { kind: 'branch', value: options.branch },
    };
  }

  const branchesClient = new BranchesClient(client);
  const [autoDetected, branches] = await Promise.all([
    resolveAutoPullRequest(client, projectKey),
    branchesClient.listBranches(projectKey),
  ]);
  if (autoDetected) {
    return {
      queryParams: { pullRequest: autoDetected.pullRequest },
      scope: {
        kind: 'pullRequestAuto',
        value: autoDetected.pullRequest,
        detectedFromBranch: autoDetected.branch,
      },
    };
  }

  const defaultBranch = branches.find((b) => b.isMain);
  if (!defaultBranch) {
    throw new CommandFailedError(`Could not determine the default branch for '${projectKey}'.`, {
      remediationHint: 'Specify --branch <name> or --pull-request <id> instead.',
    });
  }
  return { queryParams: {}, scope: { kind: 'default', value: defaultBranch.name } };
}

// Never throws — undefined (no git branch, lookup failed, no/ambiguous match) means the caller falls back to the default branch.
async function resolveAutoPullRequest(
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
): Promise<Awaited<ReturnType<PullRequestsClient['listPullRequests']>>> {
  try {
    return await new PullRequestsClient(client).listPullRequests(projectKey);
  } catch (err) {
    logger.debug(`Pull request auto-detection skipped for '${projectKey}'`, err);
    return null;
  }
}
