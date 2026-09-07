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
  private readonly orgInfoCache = new Map<string, Promise<{ id: string; uuidV4: string } | null>>();

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /**
   * Get an organization by key and return its server-side UUID (uuidV4).
   * Uses the region-specific Cloud API host (SonarQube Cloud only).
   */
  async getOrganizationId(organizationKey: string): Promise<string | null> {
    const info = await this.getOrganizationInfo(organizationKey);
    return info?.uuidV4 ?? null;
  }

  /**
   * Get an organization by key and return its legacy alphanumeric ID (not the
   * uuidV4). Some APIs, like dop-translation, key off this legacy ID rather
   * than the uuidV4 (SonarQube Cloud only).
   */
  async getOrganizationLegacyId(organizationKey: string): Promise<string | null> {
    const info = await this.getOrganizationInfo(organizationKey);
    return info?.id ?? null;
  }

  private async getOrganizationInfo(
    organizationKey: string,
  ): Promise<{ id: string; uuidV4: string } | null> {
    let pending = this.orgInfoCache.get(organizationKey);
    if (!pending) {
      pending = this.fetchOrganizationInfo(organizationKey);
      this.orgInfoCache.set(organizationKey, pending);
    }
    return pending;
  }

  private async fetchOrganizationInfo(
    organizationKey: string,
  ): Promise<{ id: string; uuidV4: string } | null> {
    try {
      const endpoint = '/organizations/organizations';
      const result = await this.client.get<Array<{ id: string; uuidV4: string }>>(
        endpoint,
        { organizationKey, excludeEligibility: 'true' },
        this.client.apiHostFor(endpoint),
      );
      return result[0] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * List the organizations the caller is a member of.
   *
   * Errors are not swallowed here. An empty list sends the login flow to the manual
   * organization prompt, so a failed request must not look like an empty list.
   */
  async listUserOrganizations(
    page = 1,
    ps = 10,
  ): Promise<{ organizations: Organization[]; total: number }> {
    const result = await this.client.get<{
      organizations: Organization[];
      paging: { total: number };
    }>('/api/organizations/search', { member: true, ps, p: page });
    return { organizations: result.organizations, total: result.paging.total };
  }

  /**
   * Resolve an organization key.
   *
   * `/api/organizations/search` answers an unknown key with `200` and an empty list. An error
   * therefore never means "no such organization", so the two cases are reported apart.
   *
   * The `organizations` filter is not limited to the caller's memberships: it also resolves
   * public organizations. That is why a hand-typed key can be validated with it.
   */
  async resolveOrganizationAccess(organizationKey: string): Promise<OrganizationAccess> {
    try {
      const organization = await this.fetchOrganizationByKey(organizationKey);
      return organization ? { status: 'accessible' } : { status: 'not_found' };
    } catch (error) {
      return { status: 'check_failed', reason: (error as Error).message };
    }
  }

  /**
   * Check if organization exists and is accessible.
   *
   * Use `resolveOrganizationAccess` to tell a missing organization from a failed lookup.
   */
  async isOrganizationAccessible(organizationKey: string): Promise<boolean> {
    const access = await this.resolveOrganizationAccess(organizationKey);
    return access.status === 'accessible';
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
  async fetchOrganizationByKey(organizationKey: string): Promise<Organization | undefined> {
    const result = await this.client.get<{ organizations: Organization[] }>(
      '/api/organizations/search',
      { organizations: organizationKey },
    );
    return result.organizations.find((org) => org.key === organizationKey);
  }

  /**
   * ALM-type lookup via `GET /dop-translation/organization-bindings` (SonarQube Cloud only,
   * region-specific API host), keyed by the org's **legacy** id (not `uuidV4`). Used to format
   * `provision_projects`' `installationKeys` param correctly for the org's connected DevOps
   * platform. Lookup failures are reported to the caller rather than swallowed, so callers can
   * tell them apart from an org that genuinely has no binding.
   */
  async getOrganizationAlmKey(organizationKey: string): Promise<string | undefined> {
    const organizationId = await this.getOrganizationLegacyId(organizationKey);
    if (!organizationId) return undefined;

    const endpoint = '/dop-translation/organization-bindings';
    const result = await this.client.get<{
      organizationBindings: Array<{ devOpsPlatform: string }>;
    }>(endpoint, { organizationId }, this.client.apiHostFor(endpoint));
    return result.organizationBindings[0]?.devOpsPlatform;
  }

  /**
   * Check whether an organization is entitled to a specific billing feature via
   * `GET /billing/entitlements` (SonarQube Cloud only, region-specific API host).
   */
  async checkBillingEntitlement(organizationUuid: string, entitlement: string): Promise<boolean> {
    try {
      const endpoint = '/billing/entitlements';
      const result = await this.client.get<{ entitlements: Array<{ allowedFeatures: string[] }> }>(
        endpoint,
        { resourceId: organizationUuid, resourceType: 'organization' },
        this.client.apiHostFor(endpoint),
      );
      return result.entitlements.some((e) => e.allowedFeatures.includes(entitlement));
    } catch (err) {
      logger.debug(`Failed to check '${entitlement}' billing entitlement`, err);
      return false;
    }
  }

  async hasPrivateProjectsEntitlement(organizationKey: string): Promise<boolean> {
    const uuid = await this.getOrganizationId(organizationKey);
    if (!uuid) return false;
    return this.checkBillingEntitlement(uuid, 'privateProjects');
  }
}
