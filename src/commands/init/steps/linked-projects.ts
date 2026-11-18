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
import { remediationHintFor } from '@/core/commands/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { ProjectOrganizationError } from '@/core/errors.ts';
import logger from '@/core/observability/logger.ts';
import { UnexpectedApiError } from '@/core/server/errors.ts';
import { HTTP_STATUS_UNAUTHORIZED } from '@/core/server/http-constants.ts';
import { ProjectsClient } from '@/core/server/projects.ts';
import type { Console } from '@/core/ui/console.ts';

import { OnboardingCancelledError } from '../answer.ts';
import type { DetectDeps } from './detect.ts';

/** A project that `.sonar-config.json` links; `path` is relative to the directory `init` reports on. */
export interface LinkedProject {
  projectKey: string;
  path: string;
}

/**
 * Why a locally linked project cannot be relied on. `missing`: the remote has no such project;
 * `other-org`: it belongs to another organization, or the token cannot read it; `unverified`: the
 * lookup itself failed, so nothing is known.
 */
export type LinkedProjectProblem = 'missing' | 'other-org' | 'unverified';

export interface LinkedProjectIssue extends LinkedProject {
  problem: LinkedProjectProblem;
}

/** What no later root can recover from: the answer to a prompt is gone, or the credentials or organization are wrong. */
export function isRunFatal(error: unknown): boolean {
  return (
    error instanceof OnboardingCancelledError ||
    error instanceof ProjectOrganizationError ||
    (error instanceof UnexpectedApiError && error.status === HTTP_STATUS_UNAUTHORIZED)
  );
}

async function lookUp(
  { projectKey }: LinkedProject,
  { auth, http }: DetectDeps,
): Promise<LinkedProjectProblem | undefined> {
  try {
    const lookup = await new ProjectsClient(http).lookupProject(projectKey, auth.orgKey).orThrow();
    switch (lookup.kind) {
      case 'missing':
        return 'missing';
      case 'other-org':
        return 'other-org';
      case 'in-org':
        return undefined;
    }
  } catch (error) {
    if (isRunFatal(error)) {
      throw error;
    }
    // A flaky API must not block `init`, which only warns about what the lookup shows.
    logger.debug(`Could not look up linked project '${projectKey}': ${remediationHintFor(error)}`);
    return 'unverified';
  }
}

/**
 * Looks each linked project up on the remote and returns the ones that cannot be relied on, in the
 * given order. Only a lookup that cannot go on at all (credentials, organization) throws.
 */
export async function findLinkedProjectIssues(
  linked: readonly LinkedProject[],
  deps: DetectDeps,
): Promise<LinkedProjectIssue[]> {
  const problems = await Promise.all(linked.map((project) => lookUp(project, deps)));
  return linked.flatMap((project, index) => {
    const problem = problems[index];
    return problem === undefined ? [] : [{ ...project, problem }];
  });
}

/** Whether the issue means the project is not there for the active connection. */
export function isUnavailable({ problem }: Pick<LinkedProjectIssue, 'problem'>): boolean {
  return problem !== 'unverified';
}

function where({ path }: LinkedProject): string {
  return path === '.' ? '' : ` (${path})`;
}

function describeIssue(issue: LinkedProjectIssue, auth: ResolvedAuth): string {
  const { projectKey } = issue;
  const links = `${SHARED_PROJECT_CONFIG_FILE_NAME} links '${projectKey}'${where(issue)}`;
  switch (issue.problem) {
    case 'missing': {
      const place = auth.orgKey ? `in organization ${auth.orgKey}` : `on ${auth.serverUrl}`;
      return `${links}, but no such project exists ${place}.`;
    }
    case 'other-org':
      return `${links}, which belongs to another organization or is not accessible with this token. Switch to the right organization or token, or fix the key.`;
    case 'unverified':
      return `Could not check whether '${projectKey}'${where(issue)} exists on the remote; ${SHARED_PROJECT_CONFIG_FILE_NAME} was left as it is.`;
  }
}

const FIX_HINT = `Relink with 'sonar link <project key>' ('sonar link --monorepo <project key> --path <directory>' for one directory of a monorepo), or delete ${SHARED_PROJECT_CONFIG_FILE_NAME}, then run 'sonar init' again.`;

/** Warns about each unavailable project, notes the unverified ones, and says once how to fix a missing project. */
export function reportLinkedProjectIssues(
  issues: readonly LinkedProjectIssue[],
  auth: ResolvedAuth,
  console: Console,
): void {
  for (const issue of issues) {
    if (isUnavailable(issue)) {
      console.warn(describeIssue(issue, auth));
    } else {
      console.info(describeIssue(issue, auth), 'stderr');
    }
  }
  if (issues.some(({ problem }) => problem === 'missing')) {
    console.print(FIX_HINT, 'stderr');
  }
}
