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

import { searchForProject } from '@/commands/link/choose-project.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { ProjectsClient } from '@/core/server/projects.ts';

import type { InitOutcome, LinkExistingOutcome } from '../init-outcome.ts';
import type { DetectDeps } from './detect.ts';
import { projectDashboardUrl, showAnalysisResults, writeMapping } from './mapping.ts';

/**
 * Asks to link the directory to the project the server already binds to the repository. When the
 * user declines, they are asked whether to link another existing project, picked with the
 * `sonar link` picker, and otherwise the path continues as `unbound-new`. The chosen
 * project is mapped in `.sonar-config.json` and its existing results are shown. A missing answer or
 * a failed write continue as `unbound-new`, leaving the onboarding incomplete.
 */
export async function runLinkExisting(
  { projectRoot, remote, projectKey: detectedKey }: LinkExistingOutcome,
  { auth, console, interactive }: DetectDeps,
): Promise<InitOutcome> {
  const unbound: InitOutcome = { path: 'unbound-new', projectRoot, remote };
  if (!interactive) {
    console.info(
      `Not linking the existing project '${detectedKey}': this needs an answer, and none can be asked.`,
      'stderr',
    );
    return unbound;
  }

  const link = await console.confirmPrompt(
    `A Sonar project already exists for this repository: '${detectedKey}'. Link this directory to it?`,
    true,
  );
  if (link === null) {
    throw new CommandFailedError('Onboarding cancelled.');
  }
  if (!link && !(await confirmAnotherProject(console))) {
    return unbound;
  }

  const http = new SonarHttpClient(auth.serverUrl, auth.token);
  const projectKey = link
    ? detectedKey
    : await searchForProject(new ProjectsClient(http), { auth, console });

  try {
    await writeMapping(auth, projectKey, projectRoot, console, `Found project '${projectKey}'`);
  } catch (error) {
    if (!(error instanceof CommandFailedError)) {
      throw error;
    }
    console.warn([error.message, error.remediationHint].filter(Boolean).join('\n'));
    return unbound;
  }

  console.success(
    `Linked this directory to project '${projectKey}' in ${SHARED_PROJECT_CONFIG_FILE_NAME}.`,
  );
  console.print(
    'The results below are the last analysis on the server, not a result for your uncommitted local changes.',
  );
  await showAnalysisResults(
    http,
    projectKey,
    projectDashboardUrl(auth, projectKey),
    console,
    'No analysis results on the server yet for this project.',
  );
  return { path: 'link-existing', projectRoot, remote, projectKey, linked: true };
}

async function confirmAnotherProject(console: DetectDeps['console']): Promise<boolean> {
  const another = await console.confirmPrompt(
    'Link this directory to another existing project instead?',
    true,
  );
  if (another === null) {
    throw new CommandFailedError('Onboarding cancelled.');
  }
  return another;
}
