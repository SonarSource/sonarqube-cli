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

import { recordConnectionFromAuth } from '@/core/auth/auth-connection-recorder.ts';
import { isSonarQubeCloud, ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { OnboardingProgress } from '@/core/commands/onboarding-progress.ts';
import { pollUntil, waitDeadline } from '@/core/commands/poll.ts';
import { openBrowser } from '@/core/host/browser.ts';
import { saveToken } from '@/core/host/keychain.ts';
import {
  CloudOnboardingClient,
  type CloudOrganization,
  type CloudSubscription,
} from '@/core/server/cloud-onboarding.ts';
import { AccessDeniedError, UnexpectedApiError } from '@/core/server/errors.ts';
import { HTTP_STATUS_NOT_FOUND } from '@/core/server/http-constants.ts';
import { OrganizationsClient } from '@/core/server/organizations.ts';
import { getActiveConnection } from '@/core/state/state-manager.ts';
import { loadState } from '@/core/state/state-repository.ts';
import type { Console } from '@/core/ui/console.ts';

const ORGANIZATIONS_PAGE_SIZE = 100;

type ImportedOrganization = CloudOrganization & { createdByCli?: boolean };

function stepError(step: string, error: Error): CommandFailedError {
  return new CommandFailedError(`${step}: ${error.message}`);
}

export interface OrgImportOptions {
  github: string;
  key?: string;
  installationId?: string;
  plan: string;
  timeout: number;
  browser?: boolean;
  format: string;
  events?: boolean;
}

function githubOwner(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'github.com'
      ? parsed.pathname.replace(/^\/|\/$/g, '').toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

function validateOptions(
  options: OrgImportOptions,
  ctx: CommandAuthenticatedInvocationContext,
): void {
  if (options.events && options.browser !== false)
    throw new InvalidOptionError(
      '--events requires --no-browser so the agent controls browser handoffs.',
    );
  if (!isSonarQubeCloud(ctx.auth.serverUrl))
    throw new CommandFailedError('Organization import is only supported on SonarQube Cloud.');
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(options.github)) {
    throw new InvalidOptionError('--github must be a GitHub account or organization name.');
  }
  if (options.key !== undefined && !options.key.trim())
    throw new InvalidOptionError('--key cannot be empty.');
  if (options.installationId !== undefined && !/^\d+$/.test(options.installationId))
    throw new InvalidOptionError('--installation-id must be a numeric GitHub App installation ID.');
  if (!['free', 'team-trial'].includes(options.plan))
    throw new InvalidOptionError('Use --plan team-trial for a cardless trial or --plan free.');
}

function assertOrganization(organization: CloudOrganization, key?: string): CloudOrganization {
  if (!organization.actions?.admin)
    throw new CommandFailedError('Organization administrator permissions are required.');
  if (key && key !== organization.key)
    throw new CommandFailedError(
      `GitHub account is already bound to '${organization.key}', not '${key}'.`,
    );
  return organization;
}

async function findBoundOrganization(
  client: CloudOnboardingClient,
  options: OrgImportOptions,
  page = 1,
): Promise<ImportedOrganization | undefined> {
  const data = await client.memberOrganizations(page).orThrow();
  const matches = data.organizations.filter(
    (org) =>
      org.alm?.key === 'github' && githubOwner(org.alm.url ?? '') === options.github.toLowerCase(),
  );
  if (matches.length > 1)
    throw new CommandFailedError('Multiple Cloud organizations match this GitHub account.');
  const organization = matches.at(0);
  if (organization) return assertOrganization(organization, options.key);
  return page * ORGANIZATIONS_PAGE_SIZE < data.paging.total
    ? findBoundOrganization(client, options, page + 1)
    : undefined;
}

async function resolveInstallation(
  client: CloudOnboardingClient,
  options: OrgImportOptions,
  installationId: string,
  console: Console,
  progress: OnboardingProgress,
): Promise<ImportedOrganization | undefined> {
  const info = await client.installationInfo(installationId).orThrow();
  if (info.almOrganization.key.toLowerCase() !== options.github.toLowerCase())
    throw new CommandFailedError('The GitHub installation belongs to a different account.');
  if (info.boundOrganization) {
    const bound = await findBoundOrganization(client, options);
    if (!bound)
      throw new CommandFailedError(
        'This installation is already bound to an inaccessible organization.',
      );
    return bound;
  }
  progress.complete('github_access', 'Your GitHub connection is ready.');
  progress.start('cloud_setup', 'Preparing a place for your project results in SonarQube Cloud.');
  const key = options.key ?? options.github.toLowerCase();
  const { organizations } = await client.organizationByKey(key).orThrow();
  const existing = organizations.find((org) => org.key === key);
  if (existing) {
    assertOrganization(existing, key);
    if (existing.alm)
      throw new CommandFailedError(
        `Organization '${key}' is already bound to another DevOps account. Choose another --key.`,
      );
    console.info(
      `Reusing organization '${key}' and connecting it to GitHub '${options.github}'.`,
      'stderr',
    );
    await client.bindOrganization(key, installationId).orThrow();
    return existing;
  }
  console.info(
    `Creating SonarQube Cloud organization '${key}' for GitHub '${options.github}'.`,
    'stderr',
  );
  const { organization } = await client
    .createOrganization(key, info.almOrganization.name || options.github, installationId)
    .orThrow();
  return { ...organization, actions: { admin: true }, createdByCli: true };
}

async function findOrCreateOrganization(
  client: CloudOnboardingClient,
  options: OrgImportOptions,
  console: Console,
  progress: OnboardingProgress,
): Promise<ImportedOrganization | undefined> {
  const bound = await findBoundOrganization(client, options);
  if (bound) return bound;
  let installationId = options.installationId;
  if (!installationId) {
    const { applications } = await client
      .listInstallations()
      .mapErr(
        (error) =>
          new CommandFailedError(`GitHub installation discovery failed: ${error.message}`, {
            remediationHint:
              'For GitHub onboarding, sign out of the SSO session in your browser and choose GitHub during sonar auth login --no-organization --non-interactive --force with your Cloud --server URL.',
          }),
      )
      .orThrow();
    const matches = applications.filter(
      (app) => app.key.toLowerCase() === options.github.toLowerCase(),
    );
    if (matches.length > 1)
      throw new CommandFailedError(
        'Multiple installations match. Pass --installation-id explicitly.',
      );
    installationId = matches.at(0)?.installationId;
  }
  if (!installationId) return undefined;
  try {
    return await resolveInstallation(client, options, installationId, console, progress);
  } catch (error) {
    // GitHub's webhook can arrive after the browser redirects back to Cloud.
    if (
      (error instanceof AccessDeniedError || error instanceof UnexpectedApiError) &&
      error.status === HTTP_STATUS_NOT_FOUND
    )
      return undefined;
    throw error;
  }
}

async function installGithubApp(
  client: CloudOnboardingClient,
  options: OrgImportOptions,
  console: Console,
  progress: OnboardingProgress,
): Promise<void> {
  const { application } = await client
    .applicationInfo()
    .mapErr(
      (error) =>
        new CommandFailedError(`GitHub App installation URL lookup failed: ${error.message}`),
    )
    .orThrow();
  const url = new URL(application.installationUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password)
    throw new CommandFailedError('Cloud returned an unexpected GitHub installation URL.');
  url.searchParams.set('state', 'sonarqube-cli');
  progress.browser(
    'github_access',
    url.href,
    `Allow SonarQube Cloud to access the repository in '${options.github}'. GitHub will show the requested permissions. Then return to your agent.`,
  );
  console.info(
    'After installation, return to this terminal. The CLI will finish organization setup and subscription signup; no plan selection is needed on the returned Cloud page.',
    'stderr',
  );
  if (options.browser === false || process.env.SONARQUBE_CLI_DISABLE_BROWSER === 'true') return;
  try {
    await openBrowser(url.href);
  } catch {
    console.warn('Could not open the browser. Open the installation URL above.');
  }
}

async function ensureSubscription(
  client: CloudOnboardingClient,
  organization: ImportedOrganization,
  id: string,
  deadline: number,
  requestedPlan: string,
): Promise<CloudSubscription> {
  // The web flow posts a subscription immediately after creating an organization.
  if (!organization.createdByCli) {
    const { subscriptions } = await client
      .subscriptions(id)
      .mapErr((error) =>
        stepError('Existing subscription lookup failed (GET /billing/subscriptions)', error),
      )
      .orThrow();
    const existing = subscriptions.at(0);
    if (existing) return existing;
  }
  let priceId: string | undefined;
  if (requestedPlan === 'free') {
    const plans = await client
      .plans()
      .mapErr((error) => stepError('Free plan lookup failed (GET /billing/plans)', error))
      .orThrow();
    const tiers = plans
      .filter((plan) => plan.name.toLowerCase() === 'free_v2')
      .flatMap((plan) => plan.tiers)
      .filter(
        (tier) =>
          tier.currencyOptions.length > 0 &&
          tier.currencyOptions.every((currency) => currency.unitAmount === 0),
      );
    const prices = [...new Set(tiers.map((tier) => tier.priceId))];
    if (prices.length !== 1)
      throw new CommandFailedError(
        'Could not identify one zero-cost Free plan. Select a plan in the Cloud UI, then rerun.',
      );
    priceId = prices[0];
  }
  const user = await client.currentUser().orThrow();
  if (requestedPlan === 'team-trial' && !user.email?.trim())
    throw new CommandFailedError('An account email is required to start the cardless Team trial.');
  await client
    .subscribe(id, organization.name, priceId, user.email)
    .mapErr((error) =>
      stepError('Subscription creation failed (POST /billing/subscriptions)', error),
    )
    .orThrow();
  const subscription = await pollUntil(
    async () => {
      const confirmed = await client
        .subscriptions(id)
        .mapErr((error) =>
          stepError('Subscription verification failed (GET /billing/subscriptions)', error),
        )
        .orThrow();
      return confirmed.subscriptions.at(0);
    },
    deadline,
    'Subscription is not visible yet. Rerun to resume signup.',
  );
  if (requestedPlan === 'team-trial') {
    const start = Date.parse(subscription.trialPeriod?.start ?? '');
    const end = Date.parse(subscription.trialPeriod?.end ?? '');
    if (
      subscription.planKey.toLowerCase() !== 'team' ||
      subscription.trial !== true ||
      subscription.status?.toLowerCase() !== 'active' ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      end <= Date.now()
    )
      throw new CommandFailedError(
        'Cloud did not confirm an active Team trial with a valid expiry. No paid fallback was attempted.',
      );
    const customer = await client.customer(id).orThrow();
    if (customer.paymentMethodStatus !== 'NONE')
      throw new CommandFailedError(
        'Cloud did not confirm a cardless trial. Review the subscription in Cloud before continuing.',
      );
  }
  return subscription;
}

async function selectOrganization(
  organization: CloudOrganization,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth, console } = ctx;
  const previous = getActiveConnection(loadState());
  if (auth.source === 'state') await saveToken(auth.serverUrl, auth.token, organization.key);
  await recordConnectionFromAuth(
    new ResolvedAuth({
      token: auth.token,
      serverUrl: auth.serverUrl,
      orgKey: organization.key,
      connectionType: 'cloud',
      source: auth.source,
    }),
    {
      force: true,
      envOnly: auth.source === 'env',
      tokenName:
        auth.source === 'state' && previous?.serverUrl === auth.serverUrl
          ? previous.tokenName
          : undefined,
    },
  );
  if (auth.source === 'env' && auth.orgKey !== organization.key)
    console.warn(
      `Set SONARQUBE_CLI_ORG=${organization.key} before running subsequent commands; environment credentials take precedence.`,
    );
}

export async function orgImport(
  options: OrgImportOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  validateOptions(options, ctx);
  const progress = new OnboardingProgress(ctx.console, options.events);
  progress.start('github_access', 'Checking your GitHub connection.');
  try {
    await importOrganization(options, ctx, progress);
  } catch (error) {
    progress.fail('Cloud setup did not complete. Return to your agent to resume the current step.');
    throw error;
  }
}

async function importOrganization(
  options: OrgImportOptions,
  ctx: CommandAuthenticatedInvocationContext,
  progress: OnboardingProgress,
): Promise<void> {
  const deadline = waitDeadline(options.timeout);
  const client = new CloudOnboardingClient(ctx.connection.httpClient);
  const initial = await findOrCreateOrganization(client, options, ctx.console, progress);
  if (!initial && !options.installationId)
    await installGithubApp(client, options, ctx.console, progress);
  const organization =
    initial ??
    (await pollUntil(
      () => findOrCreateOrganization(client, options, ctx.console, progress),
      deadline,
      'Timed out waiting for the GitHub App installation. Finish installation and rerun this command.',
    ));
  progress.complete('github_access', 'Your GitHub connection is ready.');
  progress.start(
    'cloud_setup',
    'Preparing your Cloud workspace and subscription. No action is needed from you.',
  );
  const id = await pollUntil(
    async () => {
      // Recreate the client because organization lookup caches a not-yet-visible record.
      const resolved = await new OrganizationsClient(ctx.connection.httpClient)
        .getOrganizationId(organization.key)
        .mapErr((error) =>
          stepError('Organization ID lookup failed (GET /organizations/organizations)', error),
        )
        .orThrow();
      return resolved ?? undefined;
    },
    deadline,
    'Cloud has not exposed the organization ID yet. Rerun to resume signup.',
  );
  const subscription = await ensureSubscription(client, organization, id, deadline, options.plan);
  if (subscription.trial && subscription.trialPeriod)
    ctx.console.info(
      `${subscription.planKey} trial ends ${subscription.trialPeriod.end}. Cardless trials pause when they expire unless you choose a paid plan.`,
      'stderr',
    );
  await selectOrganization(organization, ctx);
  progress.complete(
    'cloud_setup',
    'Cloud setup is complete. Your agent can now import and analyze the repository.',
  );
  const result = {
    organizationKey: organization.key,
    github: options.github.toLowerCase(),
    plan: subscription.planKey,
    trial: subscription.trial ?? false,
    ...(subscription.status ? { subscriptionStatus: subscription.status } : {}),
    ...(subscription.trialPeriod ? { trialPeriod: subscription.trialPeriod } : {}),
    url: `${ctx.auth.serverUrl}/organizations/${encodeURIComponent(organization.key)}/projects`,
  };
  if (options.format === 'json') ctx.console.print(JSON.stringify(result));
  else
    ctx.console.success(`Organization '${organization.key}' is ready (${subscription.planKey}).`);
}
