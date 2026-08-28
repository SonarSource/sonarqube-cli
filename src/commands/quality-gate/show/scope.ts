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

// Resolves which branch or pull request `quality-gate show` reports on

import { CommandFailedError, InvalidOptionError } from '@/core/command-error.ts';
import { BranchesClient } from '@/core/server/branches.ts';
import type { SonarQubeClient } from '@/core/server/client.ts';

export interface ShowQualityGateScopeOptions {
  branch?: string;
  pullRequest?: string;
}

/**
 * `branch` and `default` both hold a branch name in `value` — `default` only exists to
 * distinguish "resolved automatically" from "given explicitly" for display (the
 * "Branch main (default)" annotation). `value` is always populated: `resolveDisplayScope`
 * throws rather than return a `default` scope with no resolvable branch name.
 */
export type QualityGateScopeKind = 'branch' | 'pullRequest' | 'default';

export interface QualityGateScope {
  kind: QualityGateScopeKind;
  value: string;
}

/**
 * When neither `--branch` nor `--pull-request` is given, the project_status API already defaults
 * to the main branch server-side, so `default` scope has nothing to forward here.
 */
export function resolveScopeQueryParams(options: ShowQualityGateScopeOptions): {
  branch?: string;
  pullRequest?: string;
} {
  if (options.branch && options.pullRequest) {
    throw new InvalidOptionError('--branch and --pull-request cannot be used together.');
  }
  if (options.pullRequest) {
    return { pullRequest: options.pullRequest };
  }
  if (options.branch) {
    return { branch: options.branch };
  }
  return {};
}

/**
 * Resolves the scope purely for display (the "Branch:"/"Pull Request:" line).
 */
export async function resolveDisplayScope(
  client: SonarQubeClient,
  projectKey: string,
  options: ShowQualityGateScopeOptions,
): Promise<QualityGateScope> {
  if (options.pullRequest) {
    return { kind: 'pullRequest', value: options.pullRequest };
  }
  if (options.branch) {
    return { kind: 'branch', value: options.branch };
  }

  const branchesClient = new BranchesClient(client);
  const branches = await branchesClient.listBranches(projectKey);
  const defaultBranch = branches.find((b) => b.isMain);
  if (!defaultBranch) {
    throw new CommandFailedError(`Could not determine the default branch for '${projectKey}'.`, {
      remediationHint: 'Specify --branch <name> or --pull-request <id> instead.',
    });
  }
  return { kind: 'default', value: defaultBranch.name };
}
