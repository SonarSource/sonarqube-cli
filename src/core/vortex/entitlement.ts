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

// Vortex entitlement: the two hub queries and every way the CLI asks about them.

import { isSonarQubeCloud, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { HTTP_STATUS_NOT_FOUND } from '@/core/http-constants.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { OrganizationsClient } from '@/core/server/organizations.ts';

/**
 * `not_applicable` is returned when Vortex cannot apply to this connection: Cloud without
 * an organization (see `resolveVortexEntitlement`), or a Server missing either hub (HTTP 404).
 */
export type VortexEntitlementStatus =
  'enabled' | 'over_consumption' | 'not_entitled' | 'check_failed' | 'not_applicable';

export interface VortexEntitlementResult {
  status: VortexEntitlementStatus;
  consumption?: { consumed: number; limit: number };
}

/**
 * Server has no organizations, but entitlement lives on `/…/{id}` — omitting the
 * segment 404s. The nil UUID is a valid UUID the CLI can send without knowing
 * Server's default-org id (a backend internal). CAG's `@OrganizationId` overwrites
 * it; A3S parses then ignores it.
 */
export const SERVER_ORGANIZATION_ID_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

interface HubEntitlementResponse {
  allowed?: boolean;
  hasEntitlement?: boolean;
  consumption?: { consumed: number; limit: number };
}

function sqaaEntitlementEndpoint(client: SonarHttpClient, organizationUuid: string): string {
  return client.isCloud
    ? `/a3s-analysis/org-entitlement/${organizationUuid}`
    : `/api/v2/a3s/org-entitlement/${organizationUuid}`;
}

function cagEntitlementEndpoint(client: SonarHttpClient, organizationUuid: string): string {
  return client.isCloud
    ? `/cag/cag-entitlement/${organizationUuid}`
    : `/api/v2/cag/cag-entitlement/${organizationUuid}`;
}

/**
 * Shared entitlement GET. Both hubs return `{ allowed, hasEntitlement }`; CAG may also
 * send `consumption`. Only the path differs. A Server 404 means that hub is not
 * installed. A Cloud 404 is a fault — those services always exist.
 */
export async function checkHubEntitlement(
  client: SonarHttpClient,
  endpoint: string,
): Promise<VortexEntitlementResult> {
  try {
    const { response, value } = await client.getSafe<HubEntitlementResponse>(
      endpoint,
      undefined,
      client.apiHostFor(endpoint),
    );
    if (response.status === HTTP_STATUS_NOT_FOUND && !client.isCloud) {
      return { status: 'not_applicable' };
    }
    if (!response.ok || value === undefined) {
      return { status: 'check_failed' };
    }
    if (value.allowed) {
      return { status: 'enabled', consumption: value.consumption };
    }
    return {
      status: value.hasEntitlement ? 'over_consumption' : 'not_entitled',
      consumption: value.consumption,
    };
  } catch {
    return { status: 'check_failed' };
  }
}

/**
 * The organization id both entitlement endpoints are keyed by, or the terminal result
 * when it cannot be resolved. Server has no organizations; the path still requires
 * `{id}`, so we send {@link SERVER_ORGANIZATION_ID_PLACEHOLDER}.
 */
async function resolveEntitlementOrganizationId(
  client: SonarHttpClient,
  organizationKey?: string,
): Promise<string | VortexEntitlementResult> {
  if (!client.isCloud) {
    return SERVER_ORGANIZATION_ID_PLACEHOLDER;
  }
  if (!organizationKey) {
    return { status: 'not_entitled' };
  }
  const uuid = await new OrganizationsClient(client).getOrganizationId(organizationKey);
  return uuid ?? { status: 'check_failed' };
}

export class VortexEntitlementClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /**
   * Vortex is two hubs with no shared backend. Both are probed with the same GET mapper
   * on every connection. Server fills `{id}` with {@link SERVER_ORGANIZATION_ID_PLACEHOLDER}
   * rather than a second org-less route — a valid UUID the CLI can send without
   * knowing Server's default-org id. CAG's `@OrganizationId` rewrites that path; A3S
   * ignores it. See {@link mergeVortexEntitlement}: either hub missing or unlicensed
   * means Vortex is not available.
   */
  async hasVortexEntitlement(organizationKey?: string): Promise<VortexEntitlementResult> {
    const client = this.client;
    try {
      const uuid = await resolveEntitlementOrganizationId(client, organizationKey);
      if (typeof uuid !== 'string') {
        return uuid;
      }
      const [sqaa, cag] = await Promise.all([
        checkHubEntitlement(client, sqaaEntitlementEndpoint(client, uuid)),
        checkHubEntitlement(client, cagEntitlementEndpoint(client, uuid)),
      ]);
      return mergeVortexEntitlement(sqaa, cag);
    } catch {
      return { status: 'check_failed' };
    }
  }
}

/**
 * Vortex is one product: if either hub is missing or unlicensed, neither capability
 * loads. Priority among remaining outcomes: `check_failed > not_entitled >
 * over_consumption > enabled`.
 *
 * Only the CAG hub's `consumption` is surfaced today (A3S is licensed instance-wide and
 * reports no quota), and only for `enabled`: once over the limit the remaining headroom
 * is no longer meaningful.
 */
function mergeVortexEntitlement(
  sqaa: VortexEntitlementResult,
  cag: VortexEntitlementResult,
): VortexEntitlementResult {
  if (sqaa.status === 'not_applicable' || cag.status === 'not_applicable') {
    return { status: 'not_applicable' };
  }
  if (sqaa.status === 'check_failed' || cag.status === 'check_failed') {
    return { status: 'check_failed' };
  }
  if (sqaa.status === 'not_entitled' || cag.status === 'not_entitled') {
    return { status: 'not_entitled' };
  }
  if (sqaa.status === 'over_consumption' || cag.status === 'over_consumption') {
    return { status: 'over_consumption' };
  }
  return { status: 'enabled', consumption: cag.consumption };
}

/** Shared low-level call: every entitlement lookup in this file goes through here. */
async function queryVortexEntitlement(auth: ResolvedAuth): Promise<VortexEntitlementResult> {
  return new VortexEntitlementClient(
    new SonarHttpClient(auth.serverUrl, auth.token),
  ).hasVortexEntitlement(auth.orgKey);
}

/**
 * Re-query the combined Vortex entitlement for the resolved connection. Used to
 * reinterpret a runtime 403 (entitlement loss vs usage-limit exhaustion) without
 * coupling to any command or output layer.
 */
export async function recheckVortexEntitlement(
  auth: ResolvedAuth,
): Promise<VortexEntitlementStatus> {
  const { status } = await queryVortexEntitlement(auth);
  return status;
}

/**
 * `not_applicable` is decided here for connections that cannot ask either hub at all
 * (unauthenticated, or Cloud without an organization). Server connections are
 * queried: a missing hub returns `not_applicable` from the 404, distinct from a
 * real `not_entitled` licence refusal. Cloud vs Server follows the URL
 * (`isSonarQubeCloud`), same as `SonarHttpClient`, not the stored connection type.
 */
export async function resolveVortexEntitlement(
  auth: ResolvedAuth | null,
): Promise<VortexEntitlementResult> {
  if (!auth) {
    return { status: 'not_applicable' };
  }
  if (isSonarQubeCloud(auth.serverUrl) && !auth.orgKey) {
    return { status: 'not_applicable' };
  }
  return queryVortexEntitlement(auth);
}

export function isVortexEntitlementLoss(
  vortexEntitlement: VortexEntitlementResult,
  vortexInstalled: boolean,
): boolean {
  return vortexInstalled && vortexEntitlement.status === 'not_entitled';
}
