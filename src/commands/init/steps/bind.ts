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
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { waitInBrowser } from '@/core/host/browser.ts';
import type { Console } from '@/core/ui/console.ts';
import { QuietConsole } from '@/core/ui/quiet-console.ts';

import { requireAnswer } from '../answer.ts';
import { alreadyDone, declined, type StepResult, success } from '../flow/step-result.ts';
import type { InitStep, StepRef } from '../flow/step-runner.ts';
import type { BoundNewPath, InitOutcome, NoProjectPath } from '../init-outcome.ts';
import type { DetectDeps } from './detect.ts';
import {
  reportProjectCreated,
  serverBaseUrl,
  showAnalysisResults,
  writeMapping,
} from './mapping.ts';

interface BoundProjectTarget {
  api: ImportApiClient;
  org: ResolvedOrg;
  repositorySlug: string;
  projectRoot: string;
}

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

/** The run-level `org_bind` step: already done when linked, or the authorization it takes. */
export class OrgBindStep implements InitStep<string | undefined> {
  readonly ref = { step: 'org_bind' } as const;

  constructor(
    private readonly linkedAlmKey: string | undefined,
    private readonly api: ImportApiClient,
    private readonly auth: ResolvedAuth,
    private readonly orgKey: string,
    private readonly deps: Pick<DetectDeps, 'console' | 'interactive'>,
  ) {}

  async run(): Promise<StepResult<string | undefined>> {
    if (this.linkedAlmKey) {
      return alreadyDone(this.linkedAlmKey);
    }
    const almKey = await this.authorizeOrganization(this.api, this.auth, this.orgKey, this.deps);
    return almKey ? success(almKey) : declined(undefined);
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Asks for consent, then sends the user to the browser to link the organization to its DevOps
   * platform and waits until the server reports the link. Resolves to the platform key, or
   * undefined when consent is declined. Without a terminal it fails, since `--bind` cannot stand in
   * for a browser authorization.
   */
  private async authorizeOrganization(
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
        this.waitForAlmKey(api, orgKey, Date.now() + AUTHORIZATION_TIMEOUT_MS),
      ),
    );
  }

  /** Each check starts only after the previous one answered and the interval has passed. */
  private async waitForAlmKey(
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
    await this.pause(AUTHORIZATION_POLL_INTERVAL_MS);
    return this.waitForAlmKey(api, orgKey, deadline);
  }
}

/** Under `--bind`, the authorization is part of creating the project, so declining it creates nothing. */
class CreateBoundStep implements InitStep<string | undefined> {
  readonly ref: StepRef;

  constructor(
    private readonly target: BoundProjectTarget,
    private readonly authorizedAlmKey: () => Promise<string | undefined>,
    private readonly deps: DetectDeps,
  ) {
    this.ref = { step: 'create_project', root: deps.root };
  }

  async run(): Promise<StepResult<string | undefined>> {
    const { api, org, repositorySlug, projectRoot } = this.target;
    const { authorizedAlmKey } = this;
    const { auth, console } = this.deps;

    const almKey = await authorizedAlmKey();
    if (!almKey) {
      return declined(undefined);
    }
    console.info(`Organization: ${org.key}`);
    const projectKey = await console.withSpinner('Creating the project', () =>
      this.importRepository(
        api,
        auth,
        repositorySlug,
        { ...org, almKey },
        new QuietConsole(console),
      ),
    );
    await writeMapping(auth, projectKey, projectRoot, console, 'created');
    return success(projectKey, { projectKey });
  }

  /** Provisions the project for one repository through `sonar import`'s plan, and returns its key. */
  private async importRepository(
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
      const reason =
        plan.selection.kind === 'batch' ? plan.selection.skipped[0]?.reason : undefined;
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
}

/**
 * Creates the project bound to the repository with the `sonar import --repo` logic and maps it in
 * `.sonar-config.json`. When the user declines the DevOps platform authorization, nothing is
 * created: `--bind` ends as declined, and otherwise the no-project step says how to go on.
 */
export async function runBoundNew(
  { projectRoot, remote, repositorySlug }: BoundNewPath,
  deps: DetectDeps,
): Promise<InitOutcome | NoProjectPath> {
  const { auth, http, console, intent } = deps;
  const api = new ImportApiClient(http);
  const org = await resolveOrg(api, auth.orgKey);
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
  const authorize = (): Promise<string | undefined> =>
    deps.steps.run(new OrgBindStep(linkedAlmKey, api, auth, org.key, deps));
  const bindRequired = intent?.kind === 'bind';
  // Without `--bind`, a declined authorization leaves the no-project step to say how to go on.
  const almKey = bindRequired ? undefined : await authorize();
  if (!bindRequired && !almKey) {
    return { path: 'no-project', projectRoot, remote };
  }

  const projectKey = await deps.steps.run(
    new CreateBoundStep(
      { api, org, repositorySlug, projectRoot },
      async () => almKey ?? (await authorize()),
      deps,
    ),
  );
  if (!projectKey) {
    return { kind: 'declined' };
  }
  reportProjectCreated(console, projectKey);
  await showAnalysisResults(
    http,
    projectKey,
    console,
    'No analysis results yet: the first analysis of the new project is pending.',
  );
  return { kind: 'bound', projectKey };
}
