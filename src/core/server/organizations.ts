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

// SonarQube Organizations API wrapper (SonarQube Cloud — Server has no organizations).

import logger from '../observability/logger.ts';
import { errAsync, okAsync, type ResultAsync } from '../result.ts';
import { type HttpClientError, isCriticalFailure } from './errors.ts';
import type { SonarHttpClient } from './http-client.ts';

export interface Organization {
  key: string;
  name: string;
  alm?: { key: string };
  actions?: { admin: boolean };
  onlyPrivateProjects?: { enabled: boolean };
}

/**
 * Result of an organization lookup: found, absent, or not checkable.
 *
 * Deliberately carries no organization record. Callers only need to know whether the key resolves;
 * the one caller that needs the record itself uses `fetchOrganizationByKey`.
 */
export type OrganizationAccess =
  { status: 'accessible' } | { status: 'not_found' } | { status: 'check_failed'; reason: string };

export class OrganizationsClient {
  private readonly client: SonarHttpClient;
  private readonly orgInfoCache = new Map<
    string,
    ResultAsync<{ id: string; uuidV4: string } | null, HttpClientError>
  >();

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /**
   * Get an organization by key and return its server-side UUID (uuidV4).
   * Uses the region-specific Cloud API host (SonarQube Cloud only).
   */
  getOrganizationId(organizationKey: string): ResultAsync<string | null, HttpClientError> {
    return this.getOrganizationInfo(organizationKey).map((info) => info?.uuidV4 ?? null);
  }

  /**
   * Get an organization by key and return its legacy alphanumeric ID (not the
   * uuidV4). Some APIs, like dop-translation, key off this legacy ID rather
   * than the uuidV4 (SonarQube Cloud only).
   */
  getOrganizationLegacyId(organizationKey: string): ResultAsync<string | null, HttpClientError> {
    return this.getOrganizationInfo(organizationKey).map((info) => info?.id ?? null);
  }

  private getOrganizationInfo(
    organizationKey: string,
  ): ResultAsync<{ id: string; uuidV4: string } | null, HttpClientError> {
    let pending = this.orgInfoCache.get(organizationKey);
    if (!pending) {
      pending = this.fetchOrganizationInfo(organizationKey);
      this.orgInfoCache.set(organizationKey, pending);
    }
    return pending;
  }

  private fetchOrganizationInfo(
    organizationKey: string,
  ): ResultAsync<{ id: string; uuidV4: string } | null, HttpClientError> {
    const endpoint = '/organizations/organizations';
    return this.client
      .get<Array<{ id: string; uuidV4: string }>>(
        endpoint,
        { organizationKey, excludeEligibility: 'true' },
        this.client.apiHostFor(endpoint),
      )
      .map((result) => result[0] ?? null)
      .orElse((error) => {
        if (isCriticalFailure(error)) return errAsync(error);
        logger.debug(
          `Organization lookup for '${organizationKey}' failed: ${error.name}: ${error.message}`,
        );
        return okAsync(null);
      });
  }

  /**
   * List the organizations the caller is a member of.
   *
   * Errors are not swallowed here. An empty list sends the login flow to the manual
   * organization prompt, so a failed request must not look like an empty list.
   */
  listUserOrganizations(
    page = 1,
    ps = 10,
  ): ResultAsync<{ organizations: Organization[]; total: number }, HttpClientError> {
    return this.client
      .get<{
        organizations: Organization[];
        paging: { total: number };
      }>('/api/organizations/search', { member: true, ps, p: page })
      .map((result) => ({ organizations: result.organizations, total: result.paging.total }));
  }

  /**
   * Resolve an organization key.
   *
   * `/api/organizations/search` answers an unknown key with `200` and an empty list. An error
   * therefore never means "no such organization", so the two cases are reported apart.
   *
   * The `organizations` filter is not limited to the caller's memberships: it also resolves
   * public organizations. That is why a hand-typed key can be validated with it.
   *
   * Every outcome (accessible, not_found, or check_failed) is folded into a plain value here,
   * so this deliberately resolves to a `Promise`, not a `ResultAsync`: there is no error left to
   * propagate past this point.
   */
  resolveOrganizationAccess(organizationKey: string): Promise<OrganizationAccess> {
    return this.fetchOrganizationByKey(organizationKey).match(
      (organization): OrganizationAccess =>
        organization ? { status: 'accessible' } : { status: 'not_found' },
      (error): OrganizationAccess => ({ status: 'check_failed', reason: error.message }),
    );
  }

  /**
   * Check if organization exists and is accessible.
   *
   * Use `resolveOrganizationAccess` to tell a missing organization from a failed lookup.
   */
  isOrganizationAccessible(organizationKey: string): Promise<boolean> {
    return this.resolveOrganizationAccess(organizationKey).then(
      (access) => access.status === 'accessible',
    );
  }

  /**
   * Fetch a single organization's full record by key via `/api/organizations/search`'s
   * `organizations` filter param, without listing every org the user is a member of.
   * Used by the `sonar import --org` fast path to resolve `alm.key` and
   * `onlyPrivateProjects.enabled` up front instead of leaving them unresolved.
   *
   * Unlike most lookups in this class, network/API failures are NOT swallowed here: callers
   * rely on `onlyPrivateProjects.enabled` for visibility enforcement, and silently returning
   * `undefined` on a transient failure would silently disable that enforcement instead of
   * surfacing the problem. A `undefined` return only ever means "no org with this key".
   */
  fetchOrganizationByKey(
    organizationKey: string,
  ): ResultAsync<Organization | undefined, HttpClientError> {
    return this.client
      .get<{ organizations: Organization[] }>('/api/organizations/search', {
        organizations: organizationKey,
      })
      .map((result) => result.organizations.find((org) => org.key === organizationKey));
  }

  /**
   * ALM-type lookup via `GET /dop-translation/organization-bindings` (SonarQube Cloud only,
   * region-specific API host), keyed by the org's **legacy** id (not `uuidV4`). Used to format
   * `provision_projects`' `installationKeys` param correctly for the org's connected DevOps
   * platform. Lookup failures are reported to the caller rather than swallowed, so callers can
   * tell them apart from an org that genuinely has no binding.
   */
  getOrganizationAlmKey(organizationKey: string): ResultAsync<string | undefined, HttpClientError> {
    return this.getOrganizationLegacyId(organizationKey).andThen((organizationId) => {
      if (!organizationId) return okAsync(undefined);

      const endpoint = '/dop-translation/organization-bindings';
      return this.client
        .get<{
          organizationBindings: Array<{ devOpsPlatform: string }>;
        }>(endpoint, { organizationId }, this.client.apiHostFor(endpoint))
        .map((result) => result.organizationBindings[0]?.devOpsPlatform);
    });
  }

  /**
   * Check whether an organization is entitled to a specific billing feature via
   * `GET /billing/entitlements` (SonarQube Cloud only, region-specific API host).
   */
  checkBillingEntitlement(
    organizationUuid: string,
    entitlement: string,
  ): ResultAsync<boolean, HttpClientError> {
    const endpoint = '/billing/entitlements';
    return this.client
      .get<{ entitlements: Array<{ allowedFeatures: string[] }> }>(
        endpoint,
        { resourceId: organizationUuid, resourceType: 'organization' },
        this.client.apiHostFor(endpoint),
      )
      .map((result) => result.entitlements.some((e) => e.allowedFeatures.includes(entitlement)))
      .orElse((error) => {
        if (isCriticalFailure(error)) return errAsync(error);
        logger.debug(`Failed to check '${entitlement}' billing entitlement`, error);
        return okAsync(false);
      });
  }

  hasPrivateProjectsEntitlement(organizationKey: string): ResultAsync<boolean, HttpClientError> {
    return this.getOrganizationId(organizationKey).andThen((uuid) => {
      if (!uuid) return okAsync(false);
      return this.checkBillingEntitlement(uuid, 'privateProjects');
    });
  }
}
