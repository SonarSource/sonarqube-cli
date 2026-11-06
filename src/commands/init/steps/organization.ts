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

import { randomBytes } from 'node:crypto';

import type { OnNoMemberships } from '@/commands/components/organization/select.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import logger from '@/core/observability/logger.ts';
import { AccessDeniedError, ForbiddenApiError, UnexpectedApiError } from '@/core/server/errors.ts';
import type { BillingPlan, OrganizationsClient } from '@/core/server/organizations.ts';
import type { Console } from '@/core/ui/console.ts';

import { requireAnswer } from '../answer.ts';
import { validateProjectName } from '../options.ts';

const MAX_KEY_LENGTH = 40;
const MIN_KEY_LENGTH = 3;
const MAX_KEY_ATTEMPTS = 5;
const MAX_NAME_ATTEMPTS = 5;
const KEY_SUFFIX_BYTES = 3;
const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;
const FREE_PLAN_NAME = 'free_v2';
const SETUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;

export type OrganizationCreationStop = 'declined' | 'non-interactive' | 'unavailable';

/**
 * Thrown from the no-membership hook when `init` must end without an organization. It is not an
 * error for the user: `init` turns it into an outcome that suggests `sonar integrate`.
 */
export class OrganizationCreationStopped extends Error {
  readonly reason: OrganizationCreationStop;

  constructor(reason: OrganizationCreationStop) {
    super(`Organization creation stopped: ${reason}`);
    this.name = 'OrganizationCreationStopped';
    this.reason = reason;
  }
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start++;
  while (end > start && value[end - 1] === '-') end--;
  return value.slice(start, end);
}

/** A key SonarQube Cloud accepts, derived from the display name. */
export function deriveOrganizationKey(name: string): string {
  const slug = trimDashes(
    trimDashes(
      name
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .split('-')
        .filter(Boolean)
        .join('-'),
    ).slice(0, MAX_KEY_LENGTH),
  );
  if (!slug) {
    return 'organization';
  }
  return slug.length < MIN_KEY_LENGTH ? `${slug}-org` : slug;
}

function withRandomSuffix(base: string): string {
  const trimmed = trimDashes(base.slice(0, MAX_KEY_LENGTH - KEY_SUFFIX_BYTES * 2 - 1));
  return `${trimmed}-${randomBytes(KEY_SUFFIX_BYTES).toString('hex')}`;
}

async function askOrganizationName(console: Console): Promise<string> {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const answer = requireAnswer(
      await console.textPrompt('Organization name (for example your team or company)'),
    );
    try {
      return validateProjectName(answer, 'Organization name');
    } catch (error) {
      console.warn(error instanceof Error ? error.message : String(error));
    }
  }
  throw new CommandFailedError('No valid organization name was entered.');
}

interface CreatedOrganization {
  key: string;
  name: string;
}

/**
 * Create the organization under the first free key: the slug of the name, then random suffixes.
 * Availability is checked first, and a 409 from the create call still retries, since a key can be
 * taken between the two requests (or by an organization the lookup cannot see).
 */
async function createWithAvailableKey(
  client: OrganizationsClient,
  name: string,
): Promise<CreatedOrganization> {
  const base = deriveOrganizationKey(name);
  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
    const key = attempt === 0 ? base : withRandomSuffix(base);
    const existing = await client.fetchOrganizationByKey(key);
    if (existing.isOk() && existing.value) {
      continue;
    }

    const created = await client.createOrganization(key, name);
    if (created.isOk()) {
      return created.value.organization;
    }
    const { error } = created;
    if (error instanceof UnexpectedApiError && error.status === HTTP_CONFLICT) {
      continue;
    }
    if (
      error instanceof ForbiddenApiError ||
      (error instanceof UnexpectedApiError && error.status === HTTP_NOT_FOUND)
    ) {
      logger.debug(`Organization creation unavailable: ${error.name}: ${error.message}`);
      throw new OrganizationCreationStopped('unavailable');
    }
    throw new CommandFailedError(`Could not create organization '${key}': ${error.message}`);
  }
  throw new CommandFailedError(`Could not find a free organization key for '${name}'.`, {
    remediationHint: 'Try again with a different organization name.',
  });
}

async function pollUntil<T>(attempt: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + SETUP_TIMEOUT_MS;
  for (;;) {
    const value = await attempt();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function subscriptionFailed(organizationKey: string, reason: string): CommandFailedError {
  return new CommandFailedError(
    `Organization '${organizationKey}' was created, but its Free subscription could not be set up: ${reason}`,
    {
      remediationHint: `Choose a plan for '${organizationKey}' in the SonarQube Cloud web UI, then run 'sonar init' again.`,
    },
  );
}

/** The one zero-cost `Free_v2` price; the legacy `Free` plan and paid tiers never qualify. */
function freePriceId(plans: BillingPlan[]): string | undefined {
  const prices = new Set(
    plans
      .filter((plan) => plan.name.toLowerCase() === FREE_PLAN_NAME)
      .flatMap((plan) => plan.tiers)
      .filter(
        (tier) =>
          tier.currencyOptions.length > 0 &&
          tier.currencyOptions.every((currency) => currency.unitAmount === 0),
      )
      .map((tier) => tier.priceId),
  );
  return prices.size === 1 ? [...prices][0] : undefined;
}

/**
 * Give a freshly created organization its Free subscription. Only called for an organization
 * this run created, so no billing call ever touches one the user already had.
 */
async function ensureFreeSubscription(
  client: OrganizationsClient,
  organization: CreatedOrganization,
): Promise<void> {
  const { key } = organization;
  // Cloud exposes a new organization a moment after creating it, and answers 403/404 until then.
  const uuid = await pollUntil(async () => {
    const result = await client.getUncachedOrganizationId(key);
    if (result.isErr()) {
      if (result.error instanceof AccessDeniedError) {
        return undefined;
      }
      throw subscriptionFailed(key, `could not look up the organization (${result.error.message})`);
    }
    return result.value ?? undefined;
  });
  if (!uuid) {
    throw subscriptionFailed(key, 'Cloud did not expose the new organization in time');
  }

  // Idempotent: a subscription Cloud already attached is left alone. Before the first one exists
  // the read can answer 403/404, which counts as "none yet".
  const existing = await client.listSubscriptions(uuid);
  if (existing.isErr()) {
    const { error } = existing;
    if (!(error instanceof AccessDeniedError)) {
      throw subscriptionFailed(key, error.message);
    }
  } else if (existing.value.length > 0) {
    return;
  }

  const plans = await client.listBillingPlans();
  if (plans.isErr()) {
    throw subscriptionFailed(key, `could not list the plans (${plans.error.message})`);
  }
  const priceId = freePriceId(plans.value);
  if (!priceId) {
    throw subscriptionFailed(key, 'could not identify one zero-cost Free plan');
  }

  const email = await client.getCurrentUserEmail();
  if (email.isErr()) {
    logger.debug(`Could not read the account email: ${email.error.message}`);
  }
  const created = await client.createSubscription(
    uuid,
    organization.name,
    priceId,
    email.isOk() ? email.value : '',
  );
  if (created.isErr()) {
    throw subscriptionFailed(key, created.error.message);
  }

  const confirmed = await pollUntil(async () => {
    const result = await client.listSubscriptions(uuid);
    if (result.isErr()) {
      throw subscriptionFailed(key, `could not verify it (${result.error.message})`);
    }
    return result.value.length > 0 ? true : undefined;
  });
  if (!confirmed) {
    throw subscriptionFailed(key, 'Cloud did not confirm it in time');
  }
}

function billingUrl(baseUrl: string, organizationKey: string): string {
  return `${baseUrl}/organizations/${encodeURIComponent(organizationKey)}/billing`;
}

/**
 * The `authLogin` hook for an account with no organization: asks, creates the organization and
 * subscribes it to the Free plan, and returns its key so the login can save the connection.
 *
 * It never creates anything unasked, and a run that cannot ask stops as if the user had declined.
 * Anything it throws ends the login, which revokes the token the login just minted.
 */
export function createOrganizationHook(console: Console, interactive: boolean): OnNoMemberships {
  return async (client) => {
    if (!interactive) {
      throw new OrganizationCreationStopped('non-interactive');
    }
    console.print('Your account is not a member of any SonarQube Cloud organization.');
    console.print(
      'An organization is the workspace that holds your projects, members and plan, usually one per team or company. Creating one is free.',
    );
    const accepted = requireAnswer(
      await console.confirmPrompt('Create a SonarQube Cloud organization now?', true),
    );
    if (!accepted) {
      throw new OrganizationCreationStopped('declined');
    }

    const name = await askOrganizationName(console);
    const organization = await console.withSpinner('Creating the organization', async () => {
      const created = await createWithAvailableKey(client, name);
      await ensureFreeSubscription(client, created);
      return created;
    });
    console.success(`Created organization '${organization.name}' (${organization.key}).`);
    console.print(
      `Organization created on the Free plan. For branch analysis, private project analysis and more, upgrade your plan here: ${billingUrl(client.baseUrl, organization.key)}`,
    );
    return organization.key;
  };
}
