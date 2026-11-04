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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { BadRequestError } from '@/core/server/errors.ts';
import { ProjectsClient, type ProjectVisibility } from '@/core/server/projects.ts';
import type { Console } from '@/core/ui/console.ts';

import { requireAnswer } from '../answer.ts';
import { type UnboundNewFlags, validateProjectName, warnIgnoredUnboundNewFlags } from '../flags.ts';
import type { InitOutcome, UnboundNewOutcome } from '../init-outcome.ts';
import { generateProjectProposal, type ProjectProposal } from '../key-proposal.ts';
import type { DetectDeps } from './detect.ts';
import { projectDashboardUrl, reportProjectCreated, writeMapping } from './mapping.ts';

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

/**
 * Creates a project that is not bound to the repository and maps it in `.sonar-config.json`.
 * The key is deterministic, so a rerun after a failed mapping write finds the project it created
 * and only maps it. An explicit `--project-key` that is taken is never adopted.
 */
export async function runUnboundNew(
  { projectRoot, remote }: UnboundNewOutcome,
  { auth, http, console, interactive }: DetectDeps,
  flags: UnboundNewFlags,
): Promise<InitOutcome> {
  const generated = generateProjectProposal(projectRoot, remote, auth.orgKey);
  const proposal: ProjectProposal = {
    projectKey: flags.projectKey ?? generated.projectKey,
    projectName: flags.name ?? generated.projectName,
  };
  const projects = new ProjectsClient(http);

  const existing = await projects.findProject(proposal.projectKey, auth.orgKey).orThrow();
  if (existing) {
    if (flags.projectKey !== undefined) {
      throw new CommandFailedError(`Project '${existing.key}' already exists.`, {
        remediationHint: `Choose another --project-key, or map the existing project with 'sonar link ${existing.key}'.`,
      });
    }
    console.warn(`Project '${existing.key}' already exists; mapping it instead of creating one.`);
    warnIgnoredUnboundNewFlags({ name: flags.name, visibility: flags.visibility }, console);
    await writeMapping(auth, existing.key, projectRoot, console, 'found');
    console.success(`Saved ${SHARED_PROJECT_CONFIG_FILE_NAME} for project '${existing.key}'.`);
    return { path: 'unbound-new', projectRoot, remote, projectKey: existing.key };
  }

  let { projectName } = proposal;
  let visibility: ProjectVisibility = flags.visibility ?? 'private';
  if (interactive) {
    projectName = flags.name ?? (await askName(console, projectName));
    visibility = flags.visibility ?? (await askVisibility(console));
  }
  console.print(`Proposed project: ${projectName}`);
  console.print(`Project key: ${proposal.projectKey}`);
  console.print(`Visibility: ${visibility}`);
  if (interactive) {
    const confirmed = requireAnswer(await console.confirmPrompt('Create this project?', true));
    if (!confirmed) {
      return { path: 'unbound-new', projectRoot, remote, declined: true };
    }
  }

  const { key } = await console.withSpinner('Creating the project', () =>
    projects
      .createProject({
        projectKey: proposal.projectKey,
        name: projectName,
        visibility,
        organization: auth.orgKey,
      })
      .mapErr((error) =>
        flags.projectKey !== undefined && error instanceof BadRequestError
          ? new CommandFailedError(
              `Could not create project '${flags.projectKey}': ${error.message}`,
              {
                remediationHint:
                  'If the key is already taken (on SonarQube Cloud, keys are unique across organizations), choose another --project-key.',
              },
            )
          : error,
      )
      .orThrow(),
  );
  await writeMapping(auth, key, projectRoot, console, 'created');
  reportProjectCreated(console, key);
  console.print(`Project dashboard: ${projectDashboardUrl(auth, key)}`);
  return { path: 'unbound-new', projectRoot, remote, projectKey: key };
}
