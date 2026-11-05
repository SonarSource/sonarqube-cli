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

import { CloudBackend } from '@/commands/import/cloud-backend.ts';
import { ImportApiClient } from '@/commands/import/import-api.ts';
import { resolveAlmKey, type ResolvedOrg, resolveOrg } from '@/commands/import/resolve-options.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { openBrowserWithFallback } from '@/core/auth/token.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { Console } from '@/core/ui/console.ts';
import { QuietConsole } from '@/core/ui/quiet-console.ts';

import { requireAnswer } from '../answer.ts';
import type { BoundNewOutcome, InitOutcome } from '../init-outcome.ts';
import type { DetectDeps } from './detect.ts';
import {
  projectDashboardUrl,
  reportProjectCreated,
  serverBaseUrl,
  showAnalysisResults,
  writeMapping,
} from './mapping.ts';

const AUTHORIZATION_POLL_INTERVAL_MS = 3000;
const AUTHORIZATION_TIMEOUT_MS = 300_000;

function devOpsBindingUrl(auth: ResolvedAuth, orgKey: string): string {
  return `${serverBaseUrl(auth)}/organizations/${orgKey}/edit?category=binding`;
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
  const consent = requireAnswer(
    await console.confirmPrompt(
      `Organization '${orgKey}' is not linked to your DevOps platform. Authorize it in the browser now?`,
      true,
    ),
  );
  if (!consent) {
    return undefined;
  }

  const url = devOpsBindingUrl(auth, orgKey);
  console.print(`Link the organization to your DevOps platform: ${url}`);
  await openBrowserWithFallback(url, console);

  return console.withSpinner('Waiting for the authorization', () =>
    waitForAlmKey(api, orgKey, Date.now() + AUTHORIZATION_TIMEOUT_MS),
  );
}

/** Each check starts only after the previous one answered and the interval has passed. */
async function waitForAlmKey(
  api: ImportApiClient,
  orgKey: string,
  deadline: number,
): Promise<string> {
  const almKey = await resolveAlmKey(api, orgKey, undefined);
  if (almKey) {
    return almKey;
  }
  if (Date.now() >= deadline) {
    throw new CommandFailedError('Timed out waiting for the DevOps platform authorization.', {
      remediationHint: "Finish the authorization in the browser, then run 'sonar init' again.",
    });
  }
  await pause(AUTHORIZATION_POLL_INTERVAL_MS);
  return waitForAlmKey(api, orgKey, deadline);
}

/** Provisions the project for one repository through `sonar import`'s plan, and returns its key. */
async function importRepository(
  api: ImportApiClient,
  auth: ResolvedAuth,
  slug: string,
  org: ResolvedOrg,
  console: Console,
): Promise<string> {
  const plan = await new CloudBackend(api, auth.orgKey, auth.serverUrl, org).plan(
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
  { projectRoot, remote, repositorySlug }: BoundNewOutcome,
  { auth, http, console }: DetectDeps,
): Promise<InitOutcome> {
  const api = new ImportApiClient(http);
  const org = await resolveOrg(api, auth.orgKey);
  const almKey =
    (await resolveAlmKey(api, org.key, org.almKey)) ??
    (await authorizeOrganization(api, auth, org.key, console));
  if (!almKey) {
    return { path: 'unbound-new', projectRoot, remote };
  }

  console.info(`Organization: ${org.key}`);
  const projectKey = await console.withSpinner('Creating the project', () =>
    importRepository(api, auth, repositorySlug, { ...org, almKey }, new QuietConsole(console)),
  );

  await writeMapping(auth, projectKey, projectRoot, console, 'created');
  reportProjectCreated(console, projectKey);
  await showAnalysisResults(
    http,
    projectKey,
    projectDashboardUrl(auth, projectKey),
    console,
    'No analysis results yet: the first analysis of the new project is pending.',
  );
  return { path: 'bound-new', projectRoot, remote, repositorySlug, projectKey };
}
