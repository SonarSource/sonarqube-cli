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

import { relative, sep } from 'node:path';

import { CloudBackend } from '@/commands/import/cloud-backend.ts';
import { ImportApiClient } from '@/commands/import/import-api.ts';
import { resolveAlmKey, resolveOrg } from '@/commands/import/resolve-options.ts';
import { deriveEntry } from '@/commands/link/link-project.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { openBrowserWithFallback } from '@/core/auth/token.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { findGitRoot } from '@/core/host/git/discover.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import { sharedProjectConfigRepository } from '@/core/project-discovery/shared-project-config.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { QualityGatesClient } from '@/core/server/quality-gates.ts';
import type { Console } from '@/core/ui/console.ts';
import { QuietConsole } from '@/core/ui/quiet-console.ts';

import type { InitOutcome } from '../init-outcome.ts';
import { remoteRepositorySlug } from '../remote-host.ts';
import type { DetectDeps } from './detect.ts';

const AUTHORIZATION_POLL_INTERVAL_MS = 3000;
const AUTHORIZATION_TIMEOUT_MS = 300_000;

function devOpsBindingUrl(auth: ResolvedAuth, orgKey: string): string {
  return `${auth.serverUrl.replace(/\/$/, '')}/organizations/${orgKey}/edit?category=binding`;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Asks for consent, then sends the user to the browser to link the organization to its DevOps
 * platform and waits until the server reports the link. Resolves to the platform key, or
 * undefined when consent is declined.
 */
async function authorizeOrganization(
  api: ImportApiClient,
  auth: ResolvedAuth,
  orgKey: string,
  console: Console,
): Promise<string | undefined> {
  const consent = await console.confirmPrompt(
    `Organization '${orgKey}' is not linked to your DevOps platform. Authorize it in the browser now?`,
    true,
  );
  if (consent === null) {
    throw new CommandFailedError('Onboarding cancelled.');
  }
  if (!consent) {
    return undefined;
  }

  const url = devOpsBindingUrl(auth, orgKey);
  console.print(`Link the organization to your DevOps platform: ${url}`);
  await openBrowserWithFallback(url, console);

  return console.withSpinner('Waiting for the authorization', async () => {
    const deadline = Date.now() + AUTHORIZATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const almKey = await resolveAlmKey(api, orgKey, undefined);
      if (almKey) {
        return almKey;
      }
      await pause(AUTHORIZATION_POLL_INTERVAL_MS);
    }
    throw new CommandFailedError('Timed out waiting for the DevOps platform authorization.', {
      remediationHint: "Finish the authorization in the browser, then run 'sonar init' again.",
    });
  });
}

async function writeMapping(
  auth: ResolvedAuth,
  projectKey: string,
  projectRoot: string,
): Promise<void> {
  const { gitRoot, isGit } = findGitRoot(projectRoot);
  const configDir = canonicalizePath(isGit ? gitRoot : projectRoot);
  const path = relative(configDir, projectRoot).split(sep).join('/') || '.';
  const entry = deriveEntry(auth, projectKey, path);

  const shadowed = path === '.' ? await sharedProjectConfigRepository.set(configDir, entry) : true;
  if (shadowed) {
    await sharedProjectConfigRepository.addProject(configDir, entry);
  }
}

function projectDashboardUrl(auth: ResolvedAuth, projectKey: string): string {
  return `${auth.serverUrl.replace(/\/$/, '')}/project/overview?id=${encodeURIComponent(projectKey)}`;
}

async function showAnalysisResults(
  api: SonarHttpClient,
  projectKey: string,
  dashboardUrl: string,
  console: Console,
): Promise<void> {
  const status = await new QualityGatesClient(api).getProjectStatus({ projectKey }).match(
    (value) => value?.status ?? 'NONE',
    () => 'NONE' as const,
  );
  if (status === 'NONE') {
    console.print('No analysis results yet: the first analysis of the new project is pending.');
  } else {
    console.print(
      `Quality gate: ${status === 'OK' ? 'passed' : 'failed'}. See: sonar quality-gate status -p ${projectKey}`,
    );
  }
  console.print(`Project dashboard: ${dashboardUrl}`);
}

/** Provisions the project for one repository through `sonar import`'s plan, and returns its key. */
async function importRepository(
  api: ImportApiClient,
  auth: ResolvedAuth,
  slug: string,
  console: Console,
): Promise<string> {
  const plan = await new CloudBackend(api, auth.orgKey, auth.serverUrl).plan(
    { repo: [slug], nonInteractive: true },
    console,
  );
  if (plan.selection.kind !== 'batch' || plan.selection.repos.length !== 1) {
    const reason = plan.selection.kind === 'batch' ? plan.selection.skipped[0]?.reason : undefined;
    const detail = reason ? `: ${reason}` : '.';
    throw new CommandFailedError(`Repository '${slug}' cannot be imported${detail}`);
  }
  const projectKey = (await plan.importRepo(plan.selection.repos[0]))?.projectKey;
  if (!projectKey) {
    throw new CommandFailedError(
      `Repository '${slug}' was imported, but no project key came back.`,
    );
  }
  return projectKey;
}

/**
 * Creates the project bound to the repository with the `sonar import --repo` logic and maps it in
 * `.sonar-config.json`. Falls back to the unbound path when the user declines the DevOps
 * platform authorization.
 */
export async function runBoundNew(
  projectRoot: string,
  remote: string,
  { auth, console }: DetectDeps,
): Promise<InitOutcome> {
  const slug = remoteRepositorySlug(remote);
  if (slug === null) {
    throw new CommandFailedError(`Cannot derive the repository name from the remote '${remote}'.`);
  }

  const http = new SonarHttpClient(auth.serverUrl, auth.token);
  const api = new ImportApiClient(http);
  const org = await resolveOrg(api, auth.orgKey);
  const almKey = await resolveAlmKey(api, org.key, org.almKey);
  if (!almKey && (await authorizeOrganization(api, auth, org.key, console)) === undefined) {
    return { path: 'unbound-new', projectRoot, remote };
  }

  console.info(`Organization: ${org.key}`);
  const projectKey = await console.withSpinner('Creating the project', () =>
    importRepository(api, auth, slug, new QuietConsole(console)),
  );

  await writeMapping(auth, projectKey, projectRoot);
  console.success(`Created project '${projectKey}' and saved ${SHARED_PROJECT_CONFIG_FILE_NAME}.`);
  await showAnalysisResults(http, projectKey, projectDashboardUrl(auth, projectKey), console);
  return { path: 'bound-new', projectRoot, remote, projectKey };
}
