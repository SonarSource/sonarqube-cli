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

import {
  ProjectSelectionCancelledError,
  searchForProject,
} from '@/commands/link/choose-project.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { ProjectsClient } from '@/core/server/projects.ts';

import { requireAnswer } from '../answer.ts';
import type { InitOutcome, LinkExistingOutcome } from '../init-outcome.ts';
import type { DetectDeps } from './detect.ts';
import { linkCommandFor, showAnalysisResults, writeMapping } from './mapping.ts';

/**
 * Asks to link the directory to the project that already exists for the repository: the one the
 * server binds to it, or the one `unbound-new` found under its generated key. When the
 * user declines, they are asked whether to link another existing project, picked with the
 * `sonar link` picker. Declining that continues as `unbound-new`, and leaving the picker asks
 * whether to abandon linking (default no, which reopens the picker) before doing the same. The
 * chosen project is mapped in `.sonar-config.json` and its existing results are shown. Only the
 * user's own decision continues as `unbound-new`: when no answer can be asked, or the mapping
 * cannot be written, it fails with a `sonar link` hint, so no second project is created for a
 * repository that already has one.
 */
export async function runLinkExisting(
  { projectRoot, remote, projectKey: detectedKey }: LinkExistingOutcome,
  { auth, http, console, interactive }: DetectDeps,
): Promise<InitOutcome> {
  if (!interactive) {
    throw new CommandFailedError(
      `A Sonar project already exists for this repository: '${detectedKey}'. Linking it needs an answer, and none can be asked.`,
      {
        remediationHint: `Map it by running:\n  ${await linkCommandFor(detectedKey, projectRoot)}`,
      },
    );
  }

  const unbound: InitOutcome = { path: 'unbound-new', projectRoot, remote };
  const link = requireAnswer(
    await console.confirmPrompt(
      `A Sonar project already exists for this repository: '${detectedKey}'. Link this directory to it?`,
      true,
    ),
  );
  if (!link && !(await confirmAnotherProject(console))) {
    return unbound;
  }

  const projectKey = link
    ? detectedKey
    : await pickProject(new ProjectsClient(http), { auth, console });
  if (projectKey === null) {
    return unbound;
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
  return { path: 'link-existing', projectRoot, remote, projectKey, linked: true };
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
