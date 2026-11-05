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
import { BadRequestError } from '@/core/server/errors.ts';
import { ProjectsClient, type ProjectVisibility } from '@/core/server/projects.ts';
import type { Console } from '@/core/ui/console.ts';

import { requireAnswer } from '../answer.ts';
import { type UnboundNewFlags, validateProjectKey, validateProjectName } from '../flags.ts';
import type { InitOutcome, UnboundNewOutcome } from '../init-outcome.ts';
import { generateProjectProposal } from '../key-proposal.ts';
import type { DetectDeps } from './detect.ts';
import { runLinkExisting } from './link-existing.ts';
import { reportProjectCreated, writeMapping } from './mapping.ts';

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
  { projectRoot, remote }: UnboundNewOutcome,
  deps: DetectDeps,
  flags: UnboundNewFlags,
): Promise<InitOutcome> {
  const { auth, http, console, interactive } = deps;
  const generated = generateProjectProposal(projectRoot, remote, auth.orgKey);
  const projects = new ProjectsClient(http);

  let projectKey = flags.projectKey ?? generated.projectKey;
  const existing = await projects.findProject(projectKey, auth.orgKey).orThrow();
  if (existing) {
    if (flags.projectKey !== undefined) {
      throw new CommandFailedError(`Project '${existing.key}' already exists.`, {
        remediationHint: `Choose another --project, or map the existing project with 'sonar link ${existing.key}'.`,
      });
    }
    const linked = await runLinkExisting(
      { path: 'link-existing', projectRoot, remote, projectKey: existing.key },
      deps,
    );
    if (linked.path === 'link-existing') {
      return linked;
    }
    projectKey = await askProjectKey(console, projects, auth.orgKey, existing.key);
  }

  let projectName = flags.name ?? generated.projectName;
  let visibility: ProjectVisibility = flags.visibility ?? 'private';
  if (interactive) {
    projectName = flags.name ?? (await askName(console, projectName));
    visibility = flags.visibility ?? (await askVisibility(console));
  }
  console.print(`Proposed project: ${projectName}`);
  console.print(`Project key: ${projectKey}`);
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
        projectKey,
        name: projectName,
        visibility,
        organization: auth.orgKey,
      })
      .mapErr((error) =>
        projectKey !== generated.projectKey && error instanceof BadRequestError
          ? new CommandFailedError(`Could not create project '${projectKey}': ${error.message}`, {
              remediationHint:
                'If the key is already taken (on SonarQube Cloud, keys are unique across organizations), choose another key, for example with --project.',
            })
          : error,
      )
      .orThrow(),
  );
  await writeMapping(auth, key, projectRoot, console, 'created');
  reportProjectCreated(console, key);
  return { path: 'unbound-new', projectRoot, remote, projectKey: key };
}
