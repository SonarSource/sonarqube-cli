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
import { trimChars } from '@/core/io/strings.ts';
import logger from '@/core/observability/logger.ts';
import { errAsync, okAsync, type Result } from '@/core/result.ts';
import {
  AccessDeniedError,
  ForbiddenApiError,
  type HttpClientError,
  RateLimitError,
  ServerError,
  ServiceUnavailableError,
  TransportError,
  UnexpectedApiError,
} from '@/core/server/errors.ts';
import type {
  BillingPlan,
  BillingSubscription,
  OrganizationsClient,
} from '@/core/server/organizations.ts';
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

const INTEGRATE_FALLBACK =
  "Or run 'sonar integrate' to set up your coding agents without an organization.";

/**
 * Thrown from the no-membership hook when the user declines to create an organization. It is not
 * a failure: `init` turns it into an outcome that ends the run and exits 0. Every
 * other way the creation can stop is a `CommandFailedError`, so scripts see a non-zero exit.
 */
export class OrganizationCreationDeclined extends Error {
  constructor() {
    super('Organization creation declined');
    this.name = 'OrganizationCreationDeclined';
  }
}

function creationUnavailable(): CommandFailedError {
  return new CommandFailedError('Organization creation is not available for this account.', {
    remediationHint: `Ask an administrator to add you to an organization, then run 'sonar init' again. ${INTEGRATE_FALLBACK}`,
  });
}

/** A key SonarQube Cloud accepts, derived from the display name. */
export function deriveOrganizationKey(name: string): string {
  const slug = trimChars(
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .split('-')
      .filter(Boolean)
      .join('-')
      .slice(0, MAX_KEY_LENGTH),
    '-',
  );
  if (!slug) {
    return 'organization';
  }
  return slug.length < MIN_KEY_LENGTH ? `${slug}-org` : slug;
}

function withRandomSuffix(base: string): string {
  const trimmed = trimChars(base.slice(0, MAX_KEY_LENGTH - KEY_SUFFIX_BYTES * 2 - 1), '-');
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
      throw creationUnavailable();
    }
    throw new CommandFailedError(`Could not create organization '${key}': ${error.message}`);
  }
  throw new CommandFailedError(`Could not find a free organization key for '${name}'.`, {
    remediationHint: 'Try again with a different organization name.',
  });
}

export interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

async function pollUntil<T>(
  attempt: () => Promise<T | undefined>,
  { timeoutMs = SETUP_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS }: PollOptions = {},
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<T | undefined> => {
    const value = await attempt();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() + intervalMs > deadline) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    return poll();
  };
  return poll();
}

/** Failures that say "not yet" or "try again", as opposed to a rejection that will not change. */
function isTransient(error: HttpClientError): boolean {
  return (
    error instanceof AccessDeniedError ||
    error instanceof TransportError ||
    error instanceof RateLimitError ||
    error instanceof ServiceUnavailableError ||
    error instanceof ServerError
  );
}

/**
 * Poll `read` until it yields a value. A transient failure counts as "not yet" and is named in the
 * timeout message; any other failure ends the wait at once.
 */
async function waitFor<T>(
  organizationKey: string,
  step: { failed: string; timedOut: string },
  read: () => PromiseLike<Result<T | undefined, HttpClientError>>,
  options?: PollOptions,
): Promise<T> {
  let lastError: string | undefined;
  const value = await pollUntil(async () => {
    const result = await read();
    if (result.isOk()) {
      return result.value;
    }
    if (!isTransient(result.error)) {
      throw subscriptionFailed(organizationKey, `${step.failed} (${result.error.message})`);
    }
    lastError = result.error.message;
    return undefined;
  }, options);
  if (value === undefined) {
    throw subscriptionFailed(
      organizationKey,
      lastError ? `${step.timedOut} (last error: ${lastError})` : step.timedOut,
    );
  }
  return value;
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
export async function ensureFreeSubscription(
  client: OrganizationsClient,
  organization: CreatedOrganization,
  console: Console,
  pollOptions?: PollOptions,
): Promise<void> {
  const { key } = organization;
  // Cloud exposes a new organization a moment after creating it, and answers 403/404 until then.
  const uuid = await console.withSpinner('Waiting for SonarQube Cloud to register it', () =>
    waitFor(
      key,
      {
        failed: 'could not look up the organization',
        timedOut: 'Cloud did not expose the new organization in time',
      },
      () => client.getUncachedOrganizationId(key).map((id) => id ?? undefined),
      pollOptions,
    ),
  );
  await console.withSpinner('Setting up the Free plan', () =>
    subscribeToFree(client, organization, uuid, pollOptions),
  );
}

async function subscribeToFree(
  client: OrganizationsClient,
  organization: CreatedOrganization,
  uuid: string,
  pollOptions: PollOptions | undefined,
): Promise<void> {
  const { key } = organization;
  // Idempotent: a subscription Cloud already attached is left alone. Before the first one exists
  // the read can answer 403/404, which counts as "none yet"; other transient failures are retried
  // rather than read as "none", so a blip can neither skip the plan nor subscribe twice.
  const existing = await waitFor(
    key,
    {
      failed: 'could not check for an existing subscription',
      timedOut: 'Cloud did not answer in time',
    },
    () =>
      client
        .listSubscriptions(uuid)
        .orElse((error) =>
          error instanceof AccessDeniedError
            ? okAsync<BillingSubscription[], HttpClientError>([])
            : errAsync(error),
        )
        .map((subscriptions): BillingSubscription[] | undefined => subscriptions),
    pollOptions,
  );
  if (existing.length > 0) {
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

  await waitFor(
    key,
    { failed: 'could not verify it', timedOut: 'Cloud did not confirm it in time' },
    () =>
      client
        .listSubscriptions(uuid)
        .map((subscriptions) => (subscriptions.length > 0 ? true : undefined)),
    pollOptions,
  );
}

function billingUrl(baseUrl: string, organizationKey: string): string {
  return `${baseUrl}/organizations/${encodeURIComponent(organizationKey)}/billing`;
}

/**
 * The `authLogin` hook for an account with no organization: asks, creates the organization and
 * subscribes it to the Free plan, and returns its key so the login can save the connection.
 *
 * It never creates anything unasked, and only runs interactively (`resolveInitAuth` rejects a run
 * that cannot prompt before the login). A decline throws `OrganizationCreationDeclined`. Anything
 * it throws ends the login, which revokes the token the login just minted.
 */
export function createOrganizationHook(console: Console): OnNoMemberships {
  return async (client) => {
    console.info("You're not in a SonarQube Cloud organization yet.");
    console.print(
      "An organization holds your projects and the people you work with. Most teams have one, and it's free.",
    );
    const accepted = requireAnswer(
      await console.confirmPrompt('Create an organization now?', true),
    );
    if (!accepted) {
      throw new OrganizationCreationDeclined();
    }

    const name = await askOrganizationName(console);
    const organization = await console.withSpinner('Creating the organization', () =>
      createWithAvailableKey(client, name),
    );
    await ensureFreeSubscription(client, organization, console);
    console.success(`Created organization '${organization.name}' (key: ${organization.key}).`);
    console.info(
      `It's on the Free plan: up to 50,000 lines of private code, main branch only.\n     → What's included: ${billingUrl(client.baseUrl, organization.key)}`,
    );
    return organization.key;
  };
}
