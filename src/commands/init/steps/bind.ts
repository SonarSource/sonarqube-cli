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
import { resolveAlmKey, type ResolvedOrg } from '@/commands/import/resolve-options.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { waitInBrowser } from '@/core/host/browser.ts';
import type { Console } from '@/core/ui/console.ts';
import { QuietConsole } from '@/core/ui/quiet-console.ts';

import { requireAnswer } from '../answer.ts';
import type { BoundNewPath, InitOutcome, NoProjectPath } from '../init-outcome.ts';
import { classifyInitFailure } from '../telemetry/failure-reason.ts';
import type { DetectDeps } from './detect.ts';
import {
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

function notLinkedError(auth: ResolvedAuth, orgKey: string): CommandFailedError {
  return new CommandFailedError(
    `Organization '${orgKey}' is not linked to your DevOps platform, which binding the repository needs.`,
    {
      remediationHint: `Link it in the browser at ${devOpsBindingUrl(auth, orgKey)}, then run 'sonar init --bind' again.`,
    },
  );
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Asks for consent, then sends the user to the browser to link the organization to its DevOps
 * platform and waits until the server reports the link. Resolves to the platform key, or
 * undefined when consent is declined. Without a terminal it fails, since `--bind` cannot stand in
 * for a browser authorization.
 */
export async function authorizeOrganization(
  api: ImportApiClient,
  auth: ResolvedAuth,
  orgKey: string,
  { console, interactive }: Pick<DetectDeps, 'console' | 'interactive'>,
): Promise<string | undefined> {
  if (!interactive) {
    throw notLinkedError(auth, orgKey);
  }
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
  return waitInBrowser(url, console, (stepConsole) =>
    stepConsole.withSpinner('Waiting for the authorization', () =>
      waitForAlmKey(api, orgKey, Date.now() + AUTHORIZATION_TIMEOUT_MS),
    ),
  );
}

/** Records the run-level `org_bind` step around the authorization it may take. */
export async function authorizeUnlessLinked(
  linkedAlmKey: string | undefined,
  api: ImportApiClient,
  auth: ResolvedAuth,
  orgKey: string,
  deps: Pick<DetectDeps, 'console' | 'interactive' | 'telemetry'>,
): Promise<string | undefined> {
  const { telemetry } = deps;
  if (linkedAlmKey) {
    telemetry?.record('org_bind', 'already_done');
    return linkedAlmKey;
  }
  telemetry?.begin('org_bind');
  const almKey = await authorizeOrganization(api, auth, orgKey, deps);
  telemetry?.record('org_bind', almKey ? 'success' : 'declined');
  return almKey;
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
 * `.sonar-config.json`. When the user declines the DevOps platform authorization, nothing is
 * created: `--bind` ends as declined, and otherwise the no-project step says how to go on.
 */
export async function runBoundNew(
  { projectRoot, remote, repositorySlug, organization: org }: BoundNewPath,
  deps: DetectDeps,
): Promise<InitOutcome | NoProjectPath> {
  const { auth, http, console, intent, telemetry } = deps;
  const project = telemetry?.project(0);
  project?.begin('create_project');
  const api = new ImportApiClient(http);
  const linkedAlmKey = await resolveAlmKey(api, org.key, org.almKey);
  // The browser authorization and the import both change things, so a preview stops short of them.
  if (deps.dryRun) {
    // A real run without a terminal fails here, so its preview must fail too.
    if (!linkedAlmKey && !deps.interactive) {
      throw notLinkedError(auth, org.key);
    }
    return {
      kind: 'dry-run',
      action: {
        type: 'bind',
        repositorySlug,
        organization: org.key,
        authorizationNeeded: !linkedAlmKey,
      },
    };
  }
  let almKey: string | undefined;
  try {
    almKey = await authorizeUnlessLinked(linkedAlmKey, api, auth, org.key, deps);
  } catch (error) {
    project?.record('create_project', 'failed');
    project?.stopAt('create_project', classifyInitFailure(error));
    throw error;
  }
  if (!almKey) {
    if (intent?.kind === 'bind') {
      // `--bind` asked for this project only, so declining ends the attempt.
      project?.record('create_project', 'declined');
      project?.stopAt('create_project', 'cancelled');
      return { kind: 'declined' };
    }
    return { path: 'no-project', projectRoot, remote };
  }

  console.info(`Organization: ${org.key}`);
  const projectKey = await console.withSpinner('Creating the project', () =>
    importRepository(api, auth, repositorySlug, { ...org, almKey }, new QuietConsole(console)),
  );

  await writeMapping(auth, projectKey, projectRoot, console, 'created');
  project?.record('create_project', 'success');
  project?.setProjectKey(projectKey);
  reportProjectCreated(console, projectKey);
  await showAnalysisResults(
    http,
    projectKey,
    console,
    'No analysis results yet: the first analysis of the new project is pending.',
  );
  return { kind: 'bound', projectKey };
}
