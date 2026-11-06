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

import { describe, expect, it, mock } from 'bun:test';

import {
  createOrganizationHook,
  ensureFreeSubscription,
} from '@/commands/init/steps/organization.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { errAsync, okAsync } from '@/core/result.ts';
import {
  AccessDeniedError,
  ServerError,
  TransportError,
  UnexpectedApiError,
} from '@/core/server/errors.ts';
import type { OrganizationsClient } from '@/core/server/organizations.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const ORGANIZATION = { key: 'new-org', name: 'New Org' };
const FAST_POLL = { timeoutMs: 200, intervalMs: 5 };
const FREE_PLANS = [
  { name: 'Free_v2', tiers: [{ priceId: 'price-free', currencyOptions: [{ unitAmount: 0 }] }] },
];

type Responses = Partial<Record<keyof OrganizationsClient, unknown>>;

/** A client whose billing calls answer in sequence; the last answer repeats. */
function stubClient(responses: Responses): {
  client: OrganizationsClient;
  calls: (name: keyof OrganizationsClient) => number;
} {
  const counts = new Map<string, number>();
  const stub = Object.fromEntries(
    Object.entries(responses).map(([name, answers]) => [
      name,
      mock(() => {
        const list = answers as unknown[];
        const index = counts.get(name) ?? 0;
        counts.set(name, index + 1);
        return list[Math.min(index, list.length - 1)];
      }),
    ]),
  );
  return {
    client: stub as unknown as OrganizationsClient,
    calls: (name) => counts.get(name) ?? 0,
  };
}

describe('ensureFreeSubscription', () => {
  const subscribed = [{ planKey: 'Free_v2', status: 'active' }];

  it('keeps polling through transient failures and then subscribes once', async () => {
    const { client, calls } = stubClient({
      getUncachedOrganizationId: [
        errAsync(new AccessDeniedError(404)),
        errAsync(new ServerError(502, 'bad gateway')),
        errAsync(new TransportError('connection reset')),
        okAsync('org-uuid'),
      ],
      listSubscriptions: [okAsync([]), errAsync(new AccessDeniedError(403)), okAsync(subscribed)],
      listBillingPlans: [okAsync(FREE_PLANS)],
      getCurrentUserEmail: [okAsync('me@example.com')],
      createSubscription: [okAsync({})],
    });

    await ensureFreeSubscription(client, ORGANIZATION, new FakeConsole(), FAST_POLL);

    expect(calls('getUncachedOrganizationId')).toBe(4);
    expect(calls('createSubscription')).toBe(1);
  });

  it('shows one spinner per phase', async () => {
    const console = new FakeConsole();
    const { client } = stubClient({
      getUncachedOrganizationId: [okAsync('org-uuid')],
      listSubscriptions: [okAsync([]), okAsync(subscribed)],
      listBillingPlans: [okAsync(FREE_PLANS)],
      getCurrentUserEmail: [okAsync('me@example.com')],
      createSubscription: [okAsync({})],
    });

    await ensureFreeSubscription(client, ORGANIZATION, console, FAST_POLL);

    expect(console.findCall('spinner', 'Waiting for SonarQube Cloud')).toBeDefined();
    expect(console.findCall('spinner', 'Setting up the Free plan')).toBeDefined();
  });

  it('leaves an organization that already has a subscription alone', async () => {
    const { client, calls } = stubClient({
      getUncachedOrganizationId: [okAsync('org-uuid')],
      listSubscriptions: [okAsync(subscribed)],
      createSubscription: [okAsync({})],
    });

    await ensureFreeSubscription(client, ORGANIZATION, new FakeConsole(), FAST_POLL);

    expect(calls('createSubscription')).toBe(0);
  });

  it('stops at once on a failure that will not change', async () => {
    const { client, calls } = stubClient({
      getUncachedOrganizationId: [errAsync(new UnexpectedApiError(400, 'bad request'))],
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(
      ensureFreeSubscription(client, ORGANIZATION, new FakeConsole(), FAST_POLL),
    ).rejects.toThrow("Organization 'new-org' was created");

    expect(calls('getUncachedOrganizationId')).toBe(1);
  });

  it('names the last transient failure when the organization never shows up', async () => {
    const { client } = stubClient({
      getUncachedOrganizationId: [errAsync(new AccessDeniedError(404))],
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(
      ensureFreeSubscription(client, ORGANIZATION, new FakeConsole(), FAST_POLL),
    ).rejects.toThrow(
      'Cloud did not expose the new organization in time (last error: Access denied (HTTP 404)',
    );
  });

  it('keeps waiting through a 403/404 and reports it when the subscription never shows', async () => {
    const { client } = stubClient({
      getUncachedOrganizationId: [okAsync('org-uuid')],
      listSubscriptions: [okAsync([]), errAsync(new AccessDeniedError(404))],
      listBillingPlans: [okAsync(FREE_PLANS)],
      getCurrentUserEmail: [okAsync('')],
      createSubscription: [okAsync({})],
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(
      ensureFreeSubscription(client, ORGANIZATION, new FakeConsole(), FAST_POLL),
    ).rejects.toThrow('Cloud did not confirm it in time (last error: Access denied');
  });
});

describe('createOrganizationHook', () => {
  it('fails without prompting when the run cannot ask', async () => {
    const console = new FakeConsole();
    const { client } = stubClient({});

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(createOrganizationHook(console, false)(client)).rejects.toBeInstanceOf(
      CommandFailedError,
    );

    expect(console.calls.filter((call) => call.method.endsWith('Prompt'))).toHaveLength(0);
  });
});
