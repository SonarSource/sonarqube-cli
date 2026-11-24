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

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { ProjectsClient } from '@/core/server/projects.ts';

import { missingDecision } from '../decision.ts';
import type { InitOutcome, NoProjectPath } from '../init-outcome.ts';
import { generateProjectProposal } from '../key-proposal.ts';
import type { DetectDeps } from './detect.ts';
import { runLinkExisting } from './link-existing.ts';

const NO_PROJECT = 'No SonarQube project exists for this directory yet.';

export interface NoProjectResult {
  outcome: InitOutcome;
  /** A project was found under the generated key and offered for linking. */
  offeredLink: boolean;
}

/**
 * Nothing binds the repository to a project and no new one is bound to it. A project an earlier
 * run created under the key generated for this directory is offered for linking; otherwise the
 * run ends without creating anything, and says how to link an existing project.
 */
export async function runNoProject(
  path: NoProjectPath,
  deps: DetectDeps,
): Promise<NoProjectResult> {
  const { projectRoot, remote } = path;
  const { auth, http } = deps;
  const { projectKey } = generateProjectProposal(projectRoot, remote, auth.orgKey);
  const existing = await new ProjectsClient(http).findProject(projectKey, auth.orgKey).orThrow();
  if (existing) {
    const outcome = await runLinkExisting(
      { path: 'link-existing', projectRoot, remote, projectKey: existing.key },
      deps,
    );
    return { outcome, offeredLink: true };
  }
  return { outcome: reportNoProject(path, deps), offeredLink: false };
}

function reportNoProject(
  { repositorySlug }: NoProjectPath,
  { console, interactive, intent }: DetectDeps,
): InitOutcome {
  if (intent?.kind === 'link') {
    throw new InvalidOptionError(
      '--link found no SonarQube project for this directory.',
      'Name the project with --link <key>.',
    );
  }
  if (!interactive) {
    const options = repositorySlug ? ['--bind', '--link <key>'] : ['--link <key>'];
    throw missingDecision(NO_PROJECT, options);
  }
  console.info(
    `${NO_PROJECT} Creating a project without repository binding is not supported.`,
    'stderr',
  );
  console.info("Run 'sonar init --link <key>' to link an existing project.", 'stderr');
  return { kind: 'declined' };
}
