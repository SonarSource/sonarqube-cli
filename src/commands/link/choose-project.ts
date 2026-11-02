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
// discovery first, then a server-side search the user refines until they select one project.

import { authMatchesRecordedConnection } from '@/core/auth/recorded-connection.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';
import { discoverProjects } from '@/core/project-discovery/project-info.ts';
import { ProjectsClient } from '@/core/server/projects.ts';
import type { SonarQubeProject } from '@/core/server/types.ts';

const SEARCH_AGAIN = '__search_again__';
const PICKER_PAGE_SIZE = 25;

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
    const linked = covering.find(
      (mapping) => !monorepo || canonicalizePath(mapping.projectRoot) === root,
    );
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

/** Text prompt plus select prompt, repeated until the user selects a project. */
async function searchForProject(
  projects: ProjectsClient,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<string> {
  const { auth, console } = ctx;

  for (;;) {
    const term = await console.textPrompt('Search projects by name or key (empty lists all)');
    if (term === null) {
      throw cancelled();
    }
    const query = term.trim();

    const { components, paging } = await projects
      .searchProjects({
        q: query || undefined,
        ps: PICKER_PAGE_SIZE,
        organization: auth.orgKey,
      })
      .match(
        (result) => result,
        (error) => {
          throw new CommandFailedError(`Could not search projects: ${error.message}`, {
            remediationHint:
              "Check your network connection and the server status, or pass the key directly: 'sonar link <projectKey>'.",
          });
        },
      );

    if (components.length === 0) {
      console.warn(query ? ` No projects match '${query}'.` : ' No projects found.');
      continue;
    }
    if (paging.total > components.length) {
      console.print(
        `Showing the first ${components.length} of ${paging.total} projects. Refine your search to narrow the list.`,
      );
    }

    const choice = await console.selectPrompt<string>('Select a project', [
      ...components.map((project) => ({
        value: project.key,
        label: `${project.name} (${project.key})`,
      })),
      { value: SEARCH_AGAIN, label: 'Search again' },
    ]);
    if (choice === null) {
      throw cancelled();
    }
    if (choice !== SEARCH_AGAIN) {
      return choice;
    }
  }
}
