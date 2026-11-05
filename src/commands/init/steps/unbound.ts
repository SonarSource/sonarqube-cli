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
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { BadRequestError } from '@/core/server/errors.ts';
import { ProjectsClient, type ProjectVisibility } from '@/core/server/projects.ts';
import type { Console } from '@/core/ui/console.ts';

import { requireAnswer } from '../answer.ts';
import type { InitOutcome, UnboundNewPath } from '../init-outcome.ts';
import { generateProjectProposal } from '../key-proposal.ts';
import {
  type UnboundNewOptions,
  validateProjectName,
  warnIgnoredUnboundNewOptions,
} from '../options.ts';
import type { DetectDeps } from './detect.ts';
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

async function mapExistingProject(
  existingKey: string,
  projectRoot: string,
  { auth, console }: DetectDeps,
  options: UnboundNewOptions,
): Promise<InitOutcome> {
  console.warn(`Project '${existingKey}' already exists; mapping it instead of creating one.`);
  warnIgnoredUnboundNewOptions({ name: options.name, visibility: options.visibility }, console);
  await writeMapping(auth, existingKey, projectRoot, console, 'found');
  console.success(`Saved ${SHARED_PROJECT_CONFIG_FILE_NAME} for project '${existingKey}'.`);
  return { kind: 'unbound', projectKey: existingKey };
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
  explicitKey: string | undefined,
  { auth, http, console }: DetectDeps,
): Promise<string> {
  const { key } = await console.withSpinner('Creating the project', () =>
    new ProjectsClient(http)
      .createProject({ projectKey, name: projectName, visibility, organization: auth.orgKey })
      .mapErr((error) =>
        explicitKey !== undefined && error instanceof BadRequestError
          ? new CommandFailedError(`Could not create project '${explicitKey}': ${error.message}`, {
              remediationHint:
                'If the key is already taken (on SonarQube Cloud, keys are unique across organizations), choose another --project.',
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

/**
 * Creates a project that is not bound to the repository and maps it in `.sonar-config.json`.
 * The key is deterministic, so a rerun after a failed mapping write finds the project it created
 * and only maps it. An explicit `--project` that is taken is never adopted.
 */
export async function runUnboundNew(
  path: UnboundNewPath,
  deps: DetectDeps,
  options: UnboundNewOptions,
): Promise<InitOutcome> {
  const { projectRoot, remote } = path;
  const { auth, http, console } = deps;
  const generated = generateProjectProposal(projectRoot, remote, auth.orgKey);
  const proposal = {
    projectKey: options.projectKey ?? generated.projectKey,
    projectName: options.name ?? generated.projectName,
  };

  const existing = await new ProjectsClient(http)
    .findProject(proposal.projectKey, auth.orgKey)
    .orThrow();
  if (existing) {
    return options.projectKey === undefined
      ? mapExistingProject(existing.key, projectRoot, deps, options)
      : rejectTakenKey(existing.key);
  }

  const newProject = await chooseNewProject(proposal, options, deps);
  if (!(await confirmCreation(newProject, deps))) {
    return { kind: 'declined' };
  }
  const projectKey = await createProject(newProject, options.projectKey, deps);
  await mapCreatedProject(projectKey, projectRoot, auth, console);
  return { kind: 'unbound', projectKey };
}
