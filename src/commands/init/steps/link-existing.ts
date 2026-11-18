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

import { FolderSelectionCancelledError } from '@/commands/link/choose-folder.ts';
import {
  ProjectSelectionCancelledError,
  searchForProject,
} from '@/commands/link/choose-project.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { ProjectsClient } from '@/core/server/projects.ts';

import { requireAnswer } from '../answer.ts';
import { missingDecision } from '../decision.ts';
import type { InitOutcome, LinkExistingPath, UnboundNewPath } from '../init-outcome.ts';
import type { DetectDeps } from './detect.ts';
import { chooseLinkFolder } from './folder-selection.ts';
import { showAnalysisResults, writeMapping } from './mapping.ts';

/**
 * Asks to link the directory to the project that already exists for the repository: the one the
 * server binds to it, or the one `unbound-new` found under its generated key. When the
 * user declines, they are asked whether to link another existing project, picked with the
 * `sonar link` picker. Declining that continues as `unbound-new`, and leaving the picker asks
 * whether to abandon linking (default no, which reopens the picker) before doing the same. The
 * chosen project is mapped in `.sonar-config.json` and its existing results are shown.
 * `--link` answers the first question, and `--link <key>` names the project instead. Only the
 * user's own decision continues as `unbound-new`: `--create` or `--bind`, or no answer to ask,
 * fail instead, so no second project is created for a repository that already has one.
 */
export async function runLinkExisting(
  { projectRoot, remote, projectKey: foundKey, requested }: LinkExistingPath,
  deps: DetectDeps,
): Promise<InitOutcome | UnboundNewPath> {
  const { auth, http, console, interactive, intent } = deps;
  if (requested) {
    await assertProjectExists(new ProjectsClient(http), foundKey, auth.orgKey);
    return linkProject(foundKey, projectRoot, deps);
  }
  const situation = `A Sonar project already exists for this repository: '${foundKey}'.`;
  if (intent?.kind === 'link') {
    const linked = await linkInChosenFolder(foundKey, projectRoot, deps);
    if (linked === null) {
      throw new FolderSelectionCancelledError();
    }
    return linked;
  }
  if (intent) {
    throw new InvalidOptionError(
      `${situation} --${intent.kind} would create a second project for it.`,
      "Run 'sonar init' again with --link to link it.",
    );
  }
  if (!interactive) {
    throw missingDecision(situation, ['--link']);
  }

  const unbound: UnboundNewPath = { path: 'unbound-new', projectRoot, remote };
  const link = requireAnswer(
    await console.confirmPrompt(`${situation} Link this directory to it?`, true),
  );
  if (!link && !(await confirmAnotherProject(console))) {
    return unbound;
  }

  const projectKey = link
    ? foundKey
    : await pickProject(new ProjectsClient(http), { auth, console });
  if (projectKey === null) {
    return unbound;
  }
  // Leaving the folder prompts takes back the agreement to link, like declining it.
  return (await linkInChosenFolder(projectKey, projectRoot, deps)) ?? unbound;
}

/** The user has agreed to link, so this is when they say which folder to link. */
async function linkInChosenFolder(
  projectKey: string,
  projectRoot: string,
  deps: DetectDeps,
): Promise<InitOutcome | null> {
  const target = await chooseLinkFolder(projectRoot, deps);
  return 'cancelled' in target ? null : linkProject(projectKey, target.projectRoot, deps);
}

/** `--link <key>` is checked before it is written, since nothing found it on the server. */
async function assertProjectExists(
  projects: ProjectsClient,
  projectKey: string,
  organization: string | undefined,
): Promise<void> {
  if (!(await projects.findProject(projectKey, organization).orThrow())) {
    const where = organization ? ` in organization '${organization}'` : '';
    throw new InvalidOptionError(
      `--link names project '${projectKey}', which does not exist${where}.`,
      "Check the key, or run 'sonar init' again with --create to create a new project.",
    );
  }
}

async function linkProject(
  projectKey: string,
  projectRoot: string,
  { auth, http, console, dryRun }: DetectDeps,
): Promise<InitOutcome> {
  if (dryRun) {
    return { kind: 'dry-run', action: { type: 'link', projectKey } };
  }
  await writeMapping(auth, projectKey, projectRoot, console, 'found');

  console.success(
    `Linked this directory to project '${projectKey}' in ${SHARED_PROJECT_CONFIG_FILE_NAME}.`,
  );
  console.print(
    'The results below are the last analysis on the server, not a result for your uncommitted local changes.',
  );
  await showAnalysisResults(
    http,
    projectKey,
    console,
    'No analysis results on the server yet for this project.',
  );
  return { kind: 'linked', projectKey };
}

async function confirmAnotherProject(console: DetectDeps['console']): Promise<boolean> {
  return requireAnswer(
    await console.confirmPrompt('Link this directory to another existing project instead?', true),
  );
}

/** Leaving the picker asks whether to give up linking; declining reopens it. */
async function pickProject(
  projects: ProjectsClient,
  ctx: Pick<DetectDeps, 'auth' | 'console'>,
): Promise<string | null> {
  for (;;) {
    try {
      return await searchForProject(projects, ctx);
    } catch (error) {
      if (!(error instanceof ProjectSelectionCancelledError)) {
        throw error;
      }
    }
    const abandon = requireAnswer(
      await ctx.console.confirmPrompt(
        'Abandon linking a project and create a new project without repository binding instead?',
        false,
      ),
    );
    if (abandon) {
      return null;
    }
  }
}
