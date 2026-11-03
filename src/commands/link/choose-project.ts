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

// Picks the project for `sonar link` when no key is given: a verified proposal from project
// discovery first, then a live server-side search the user narrows by typing.

import { authMatchesRecordedConnection } from '@/core/auth/recorded-connection.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';
import { discoverProjects } from '@/core/project-discovery/project-info.ts';
import { ProjectsClient } from '@/core/server/projects.ts';
import type { SonarQubeProject } from '@/core/server/types.ts';

const PICKER_PAGE_SIZE = 10;
// /api/components/search silently returns nothing for a one-character `q`.
const MIN_SEARCH_LENGTH = 2;

export function assertCanChooseProject(
  ctx: Pick<CommandAuthenticatedInvocationContext, 'console'>,
): void {
  if (ctx.console.canPrompt()) {
    return;
  }
  throw new CommandFailedError('No project key given, and this terminal cannot prompt for one.', {
    remediationHint: "Pass the project key explicitly: 'sonar link <projectKey>'.",
  });
}

function cancelled(): CommandFailedError {
  return new CommandFailedError('Project selection cancelled');
}

/**
 * Resolves the key to link `projectRoot` to, or `null` when it is already linked and the user
 * keeps that link. Throws when the terminal cannot prompt or the user cancels. With `monorepo`,
 * an existing mapping above `projectRoot` does not count as linking it.
 */
export async function chooseProjectKey(
  projectRoot: string,
  monorepo: boolean,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<string | null> {
  assertCanChooseProject(ctx);
  const { auth, console } = ctx;
  const projects = new ProjectsClient(ctx.connection.httpClient);

  const discovered = await discoverProjects(projectRoot, { auth, silent: true, console });
  const root = canonicalizePath(projectRoot);
  const covering = discovered.scope(root).filter((mapping) => mapping.contains);

  if (discovered.fromSharedConfig) {
    // Other directories' mappings are never proposed again; only one covering this directory counts.
    const owner = discovered.groupByMapping([root]).groups.at(0)?.mapping;
    const linked =
      owner && (!monorepo || canonicalizePath(owner.projectRoot) === root) ? owner : undefined;
    return linked
      ? relinkOrKeep(projectRoot, linked.projectKey, projects, ctx)
      : searchForProject(projects, ctx);
  }

  const proposed = await findProposal(covering, projects, ctx);
  if (proposed) {
    const accepted = await console.confirmPrompt(
      `Link ${projectRoot} to ${proposed.name} (${proposed.key})?`,
      true,
    );
    if (accepted === null) {
      throw cancelled();
    }
    if (accepted) {
      return proposed.key;
    }
  }

  return searchForProject(projects, ctx);
}

async function relinkOrKeep(
  projectRoot: string,
  linkedKey: string,
  projects: ProjectsClient,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<string | null> {
  ctx.console.info(`${projectRoot} is already linked to project ${linkedKey}.`);
  const relink = await ctx.console.confirmPrompt('Link it to another project instead?', false);
  if (relink === null) {
    throw cancelled();
  }
  return relink ? searchForProject(projects, ctx) : null;
}

/** The first discovered candidate that matches the connection and exists on the server, if any. */
async function findProposal(
  covering: readonly CompleteProjectMapping[],
  projects: ProjectsClient,
  { auth }: CommandAuthenticatedInvocationContext,
): Promise<SonarQubeProject | null> {
  for (const candidate of covering) {
    if (!authMatchesRecordedConnection(auth, candidate)) {
      continue;
    }
    // Sequential on purpose: the first candidate that exists wins.
    const project = await verifyProject(projects, candidate.projectKey, auth.orgKey);
    if (project) {
      return project;
    }
  }
  return null;
}

function verifyProject(
  projects: ProjectsClient,
  projectKey: string,
  organization: string | undefined,
): Promise<SonarQubeProject | null> {
  return projects.findProject(projectKey, organization).match(
    (project) => project,
    (error) => {
      logger.debug(`Could not verify discovered project '${projectKey}': ${error.message}`);
      return null;
    },
  );
}

/** Live search: the server filters as the user types, until they pick one project. */
export async function searchForProject(
  projects: ProjectsClient,
  { auth, console }: Pick<CommandAuthenticatedInvocationContext, 'auth' | 'console'>,
): Promise<string> {
  const choice = await console.searchPrompt<string>('Choose a project', {
    hint: 'type a name or key',
    noun: 'projects',
    minQueryLength: MIN_SEARCH_LENGTH,
    search: async (query) => {
      const { components, paging } = await fetchProjectPage(projects, query, auth.orgKey);
      return {
        options: components.map((project) => ({
          value: project.key,
          label: project.name,
          detail: project.key === project.name ? undefined : project.key,
        })),
        total: paging.total,
      };
    },
  });
  if (choice === null) {
    throw cancelled();
  }
  return choice;
}

function fetchProjectPage(
  projects: ProjectsClient,
  query: string,
  organization: string | undefined,
) {
  return projects
    .searchProjects({ q: query || undefined, ps: PICKER_PAGE_SIZE, organization })
    .match(
      (result) => result,
      (error) => {
        throw new CommandFailedError(`Could not search projects: ${error.message}`, {
          remediationHint:
            "Check your network connection and the server status, or pass the key directly: 'sonar link <projectKey>'.",
        });
      },
    );
}
