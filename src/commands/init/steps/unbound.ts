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
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { BadRequestError } from '@/core/server/errors.ts';
import { ProjectsClient, type ProjectVisibility } from '@/core/server/projects.ts';
import type { Console } from '@/core/ui/console.ts';

import { requireAnswer } from '../answer.ts';
import type { InitOutcome, UnboundNewPath } from '../init-outcome.ts';
import { generateProjectProposal } from '../key-proposal.ts';
import {
  type UnboundNewOptions,
  validateProjectKey,
  validateProjectName,
} from '../options.ts';
import type { DetectDeps } from './detect.ts';
import { runLinkExisting } from './link-existing.ts';
import { reportProjectCreated, writeMapping } from './mapping.ts';

interface NewProject {
  projectKey: string;
  projectName: string;
  visibility: ProjectVisibility;
}

async function askName(console: Console, fallback: string): Promise<string> {
  for (;;) {
    const answer = requireAnswer(await console.textPrompt(`Project name (default: ${fallback})`));
    if (answer.trim() === '') {
      return fallback;
    }
    try {
      return validateProjectName(answer, 'Project name');
    } catch (error) {
      console.warn(error instanceof Error ? error.message : String(error));
    }
  }
}

async function askVisibility(console: Console): Promise<ProjectVisibility> {
  return requireAnswer(
    await console.selectPrompt<ProjectVisibility>('Project visibility', [
      { value: 'private', label: 'Private' },
      { value: 'public', label: 'Public' },
    ]),
  );
}

/** An explicit `--project` is never adopted, so a taken one is an error rather than a resume. */
function rejectTakenKey(existingKey: string): never {
  throw new CommandFailedError(`Project '${existingKey}' already exists.`, {
    remediationHint: `Choose another --project, or map the existing project with 'sonar link ${existingKey}'.`,
  });
}

async function chooseNewProject(
  proposal: { projectKey: string; projectName: string },
  options: UnboundNewOptions,
  { console, interactive }: DetectDeps,
): Promise<NewProject> {
  const { projectKey } = proposal;
  if (!interactive) {
    return {
      projectKey,
      projectName: proposal.projectName,
      visibility: options.visibility ?? 'private',
    };
  }
  return {
    projectKey,
    projectName: options.name ?? (await askName(console, proposal.projectName)),
    visibility: options.visibility ?? (await askVisibility(console)),
  };
}

async function confirmCreation(
  { projectKey, projectName, visibility }: NewProject,
  { console, interactive }: DetectDeps,
): Promise<boolean> {
  console.print(`Proposed project: ${projectName}`);
  console.print(`Project key: ${projectKey}`);
  console.print(`Visibility: ${visibility}`);
  return !interactive || requireAnswer(await console.confirmPrompt('Create this project?', true));
}

async function createProject(
  { projectKey, projectName, visibility }: NewProject,
  chosenKey: string | undefined,
  { auth, http, console }: DetectDeps,
): Promise<string> {
  const { key } = await console.withSpinner('Creating the project', () =>
    new ProjectsClient(http)
      .createProject({ projectKey, name: projectName, visibility, organization: auth.orgKey })
      .mapErr((error) =>
        chosenKey !== undefined && error instanceof BadRequestError
          ? new CommandFailedError(`Could not create project '${chosenKey}': ${error.message}`, {
              remediationHint:
                'If the key is already taken (on SonarQube Cloud, keys are unique across organizations), choose another key, for example with --project.',
            })
          : error,
      )
      .orThrow(),
  );
  return key;
}

async function mapCreatedProject(
  projectKey: string,
  projectRoot: string,
  auth: ResolvedAuth,
  console: Console,
): Promise<void> {
  await writeMapping(auth, projectKey, projectRoot, console, 'created');
  reportProjectCreated(console, projectKey);
}

/** Asks for the key of the new project after the generated one turned out to be taken. */
async function askProjectKey(
  console: Console,
  projects: ProjectsClient,
  organization: string | undefined,
  takenKey: string,
): Promise<string> {
  for (let attempt = 2; ; attempt++) {
    const suggestion = `${takenKey}-${attempt}`;
    const answer = requireAnswer(await console.textPrompt(`Project key (default: ${suggestion})`));
    let candidate: string;
    try {
      candidate = validateProjectKey(answer.trim() === '' ? suggestion : answer, 'Project key');
    } catch (error) {
      console.warn(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (await projects.findProject(candidate, organization).orThrow()) {
      console.warn(`Project '${candidate}' already exists.`);
      continue;
    }
    return candidate;
  }
}

/**
 * Creates a project that is not bound to the repository and maps it in `.sonar-config.json`.
 * When the generated key is already taken (an earlier run created it), nothing is mapped without
 * the user's say: the `link-existing` step offers the project, and declining it asks for another
 * key. An explicit `--project` that is taken is never adopted.
 */
export async function runUnboundNew(
  path: UnboundNewPath,
  deps: DetectDeps,
  options: UnboundNewOptions,
): Promise<InitOutcome> {
  const { projectRoot, remote } = path;
  const { auth, http, console } = deps;
  const generated = generateProjectProposal(projectRoot, remote, auth.orgKey);
  const projects = new ProjectsClient(http);

  let projectKey = options.projectKey ?? generated.projectKey;
  const existing = await projects.findProject(projectKey, auth.orgKey).orThrow();
  if (existing) {
    if (options.projectKey !== undefined) {
      rejectTakenKey(existing.key);
    }
    const linked = await runLinkExisting(
      { path: 'link-existing', projectRoot, remote, projectKey: existing.key },
      deps,
    );
    if ('kind' in linked) {
      return linked;
    }
    projectKey = await askProjectKey(console, projects, auth.orgKey, existing.key);
  }

  const newProject = await chooseNewProject(
    { projectKey, projectName: options.name ?? generated.projectName },
    options,
    deps,
  );
  if (!(await confirmCreation(newProject, deps))) {
    return { kind: 'declined' };
  }
  const chosenKey = projectKey === generated.projectKey ? undefined : projectKey;
  const createdKey = await createProject(newProject, chosenKey, deps);
  await mapCreatedProject(createdKey, projectRoot, auth, console);
  return { kind: 'unbound', projectKey: createdKey };
}
