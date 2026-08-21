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

// Fetches and disk-caches server-side identity fields (user/org/enterprise/installation UUIDs) for a resolved auth.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import { resolveFromEndpoint } from '@/core/server/sonarcloud-region.ts';

import { getTelemetryDir } from '../config-constants.ts';
import type { AuthConnection, ServerType } from '../state/state.ts';

const ORGANIZATIONS_ENDPOINT = '/organizations/organizations';
const ENTERPRISE_ORGANIZATIONS_ENDPOINT = '/enterprises/enterprise-organizations';

export interface TelemetryIdentity {
  user_uuid: string | null;
  organization_uuid_v4: string | null;
  enterprise_uuid: string | null;
  sqs_installation_id: string | null;
}

export const EMPTY_IDENTITY: TelemetryIdentity = {
  user_uuid: null,
  organization_uuid_v4: null,
  enterprise_uuid: null,
  sqs_installation_id: null,
};

export function identityFromConnection(conn: AuthConnection | undefined): TelemetryIdentity {
  return {
    user_uuid: conn?.userUuid ?? null,
    organization_uuid_v4: conn?.organizationUuidV4 ?? null,
    enterprise_uuid: conn?.enterpriseUuid ?? null,
    sqs_installation_id: conn?.sqsInstallationId ?? null,
  };
}

export function isIdentityCompleteForConnection(
  identity: TelemetryIdentity,
  connectionType: ServerType,
): boolean {
  if (connectionType === 'cloud') {
    return !!identity.user_uuid && !!identity.organization_uuid_v4;
  }
  // user_uuid may be absent on older SonarQube Server versions (see TelemetryEventPayload).
  return !!identity.sqs_installation_id;
}

/** Login persists `userUuid` (string or null); undefined means we have not tried yet. */
function connectionUserUuidResolved(conn: AuthConnection | undefined): boolean {
  return conn?.userUuid !== undefined;
}

/** Login persists `enterpriseUuid` (string or null); undefined means we have not tried yet. */
function connectionEnterpriseUuidResolved(conn: AuthConnection | undefined): boolean {
  return conn?.enterpriseUuid !== undefined;
}

export function needsIdentityEnrichment(
  identity: TelemetryIdentity,
  connectionType: ServerType,
  conn: AuthConnection | undefined,
): boolean {
  if (!isIdentityCompleteForConnection(identity, connectionType)) {
    return true;
  }
  if (!identity.user_uuid && !connectionUserUuidResolved(conn)) {
    return true;
  }
  return connectionType === 'cloud' && !connectionEnterpriseUuidResolved(conn);
}

interface CacheEntry {
  userUuid?: string | null;
  organizationUuidV4?: string | null;
  enterpriseUuid?: string | null;
  sqsInstallationId?: string | null;
}

interface IdentityCacheFile {
  entries: Record<string, CacheEntry>;
}

interface IdentityFetchPlan {
  user: boolean;
  org: boolean;
  enterprise: boolean;
  sqs: boolean;
}

const CACHE_FILENAME = 'identity-cache.json';
const TOKEN_FINGERPRINT_HEX_LENGTH = 16;

export function mergeIdentity(
  base: TelemetryIdentity,
  partial: Partial<TelemetryIdentity>,
): TelemetryIdentity {
  return {
    user_uuid: partial.user_uuid ?? base.user_uuid,
    organization_uuid_v4: partial.organization_uuid_v4 ?? base.organization_uuid_v4,
    enterprise_uuid: partial.enterprise_uuid ?? base.enterprise_uuid,
    sqs_installation_id: partial.sqs_installation_id ?? base.sqs_installation_id,
  };
}

function cacheKey(auth: ResolvedAuth): string {
  const fingerprint = createHash('sha256')
    .update(auth.token)
    .digest('hex')
    .slice(0, TOKEN_FINGERPRINT_HEX_LENGTH);
  return [auth.connectionType, auth.serverUrl, auth.orgKey ?? '', fingerprint].join('|');
}

function cacheEntryToIdentity(entry: CacheEntry): TelemetryIdentity {
  return {
    user_uuid: entry.userUuid ?? null,
    organization_uuid_v4: entry.organizationUuidV4 ?? null,
    enterprise_uuid: entry.enterpriseUuid ?? null,
    sqs_installation_id: entry.sqsInstallationId ?? null,
  };
}

function fetchPlanIsComplete(plan: IdentityFetchPlan): boolean {
  return !plan.user && !plan.org && !plan.enterprise && !plan.sqs;
}

function planFieldsToFetch(
  auth: ResolvedAuth,
  identity: TelemetryIdentity,
  entry?: CacheEntry,
): IdentityFetchPlan {
  return {
    user: !identity.user_uuid && !(entry && 'userUuid' in entry),
    org:
      auth.connectionType === 'cloud' &&
      !!auth.orgKey &&
      !identity.organization_uuid_v4 &&
      !(entry && 'organizationUuidV4' in entry),
    enterprise:
      auth.connectionType === 'cloud' &&
      !!auth.orgKey &&
      !identity.enterprise_uuid &&
      !(entry && 'enterpriseUuid' in entry),
    sqs:
      auth.connectionType === 'on-premise' &&
      !identity.sqs_installation_id &&
      !(entry && 'sqsInstallationId' in entry),
  };
}

function readDiskCache(): IdentityCacheFile {
  const path = join(getTelemetryDir(), CACHE_FILENAME);
  if (!existsSync(path)) {
    return { entries: {} };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'entries' in parsed &&
      typeof (parsed as IdentityCacheFile).entries === 'object'
    ) {
      return parsed as IdentityCacheFile;
    }
  } catch {
    return { entries: {} };
  }
  return { entries: {} };
}

function writeDiskCache(cache: IdentityCacheFile): void {
  try {
    mkdirSync(getTelemetryDir(), { recursive: true });
    writeFileSync(join(getTelemetryDir(), CACHE_FILENAME), JSON.stringify(cache));
  } catch {
    // Best-effort — read-only or ephemeral filesystems skip persistence.
  }
}

interface FieldFetchResult {
  value: string | null;
  resolved: boolean;
}

interface OrganizationRecord {
  id?: string;
  uuidV4?: string;
}

interface OrganizationLookupResult {
  uuidV4: string | null;
  id: string | null;
  resolved: boolean;
}

async function fetchUserUuid(client: SonarQubeClient): Promise<FieldFetchResult> {
  try {
    const { response, value } = await client.getSafe<{ id: string }>('/api/users/current');
    if (!response.ok) {
      return { value: null, resolved: false };
    }
    return { value: value?.id ?? null, resolved: true };
  } catch {
    return { value: null, resolved: false };
  }
}

async function fetchOrganizationRecord(
  client: SonarQubeClient,
  serverUrl: string,
  orgKey: string,
): Promise<OrganizationLookupResult> {
  try {
    const { response, value } = await client.getSafe<OrganizationRecord[]>(
      ORGANIZATIONS_ENDPOINT,
      { organizationKey: orgKey, excludeEligibility: 'true' },
      resolveFromEndpoint(serverUrl, ORGANIZATIONS_ENDPOINT),
    );
    if (!response.ok) {
      return { uuidV4: null, id: null, resolved: false };
    }
    const org = value?.[0];
    return { uuidV4: org?.uuidV4 ?? null, id: org?.id ?? null, resolved: true };
  } catch {
    return { uuidV4: null, id: null, resolved: false };
  }
}

async function fetchEnterpriseUuid(
  client: SonarQubeClient,
  serverUrl: string,
  organizationId: string,
): Promise<FieldFetchResult> {
  try {
    const { response, value } = await client.getSafe<Array<{ enterpriseId?: string }>>(
      ENTERPRISE_ORGANIZATIONS_ENDPOINT,
      { organizationId },
      resolveFromEndpoint(serverUrl, ENTERPRISE_ORGANIZATIONS_ENDPOINT),
    );
    if (!response.ok) {
      return { value: null, resolved: false };
    }
    return { value: value?.[0]?.enterpriseId ?? null, resolved: true };
  } catch {
    return { value: null, resolved: false };
  }
}

async function fetchSqsInstallationId(client: SonarQubeClient): Promise<FieldFetchResult> {
  try {
    const { response, value } = await client.getSafe<{ id?: string }>('/api/system/status');
    if (!response.ok) {
      return { value: null, resolved: false };
    }
    return { value: value?.id ?? null, resolved: true };
  } catch {
    return { value: null, resolved: false };
  }
}

interface IdentityFetchResult {
  identity: TelemetryIdentity;
  resolved: IdentityFetchPlan;
}

async function fetchMissingFromApi(
  auth: ResolvedAuth,
  identity: TelemetryIdentity,
  fetchPlan: IdentityFetchPlan,
): Promise<IdentityFetchResult> {
  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  let { user_uuid, organization_uuid_v4, enterprise_uuid, sqs_installation_id } = identity;
  const resolved: IdentityFetchPlan = { user: false, org: false, enterprise: false, sqs: false };

  if (fetchPlan.user) {
    const user = await fetchUserUuid(client);
    user_uuid = user.value;
    resolved.user = user.resolved;
  }
  if ((fetchPlan.org || fetchPlan.enterprise) && auth.orgKey) {
    const org = await fetchOrganizationRecord(client, auth.serverUrl, auth.orgKey);
    if (fetchPlan.org) {
      organization_uuid_v4 = org.uuidV4;
      resolved.org = org.resolved;
    }
    if (fetchPlan.enterprise) {
      if (!org.resolved) {
        enterprise_uuid = null;
        resolved.enterprise = false;
      } else if (!org.id) {
        enterprise_uuid = null;
        resolved.enterprise = true;
      } else {
        const enterprise = await fetchEnterpriseUuid(client, auth.serverUrl, org.id);
        enterprise_uuid = enterprise.value;
        resolved.enterprise = enterprise.resolved;
      }
    }
  }
  if (fetchPlan.sqs) {
    const sqs = await fetchSqsInstallationId(client);
    sqs_installation_id = sqs.value;
    resolved.sqs = sqs.resolved;
  }

  return {
    identity: { user_uuid, organization_uuid_v4, enterprise_uuid, sqs_installation_id },
    resolved,
  };
}

interface TelemetryIdentityResolution {
  identity: TelemetryIdentity;
  /** True when enterprise UUID is known, including confirmed-absent `null`. */
  persistEnterprise: boolean;
}

/** Never throws — a failed fetch just leaves the field null and is retried next call. */
export async function resolveTelemetryIdentity(
  auth: ResolvedAuth,
  seed: TelemetryIdentity = EMPTY_IDENTITY,
): Promise<TelemetryIdentity> {
  return (await resolveTelemetryIdentityResolution(auth, seed)).identity;
}

/**
 * Like {@link resolveTelemetryIdentity}, plus whether `enterpriseUuid` is safe to
 * persist on the connection. Transient enterprise lookup failures must not be
 * written as confirmed-absent `null`, or later commands would skip the retry.
 */
export async function resolveTelemetryIdentityResolution(
  auth: ResolvedAuth,
  seed: TelemetryIdentity = EMPTY_IDENTITY,
): Promise<TelemetryIdentityResolution> {
  const entryKey = cacheKey(auth);
  const diskCache = readDiskCache();
  const diskEntry = entryKey in diskCache.entries ? diskCache.entries[entryKey] : undefined;

  let identity = mergeIdentity(EMPTY_IDENTITY, seed);
  if (diskEntry !== undefined) {
    identity = mergeIdentity(identity, cacheEntryToIdentity(diskEntry));
  }

  const fetchPlan = planFieldsToFetch(auth, identity, diskEntry);
  if (fetchPlanIsComplete(fetchPlan)) {
    return { identity, persistEnterprise: !fetchPlan.enterprise };
  }

  const fetchResult = await fetchMissingFromApi(auth, identity, fetchPlan);
  identity = fetchResult.identity;

  const updatedEntry: CacheEntry = diskEntry === undefined ? {} : { ...diskEntry };
  if (fetchPlan.user && fetchResult.resolved.user) {
    updatedEntry.userUuid = identity.user_uuid;
  }
  if (fetchPlan.org && fetchResult.resolved.org) {
    updatedEntry.organizationUuidV4 = identity.organization_uuid_v4;
  }
  if (fetchPlan.enterprise && fetchResult.resolved.enterprise) {
    updatedEntry.enterpriseUuid = identity.enterprise_uuid;
  }
  if (fetchPlan.sqs && fetchResult.resolved.sqs) {
    updatedEntry.sqsInstallationId = identity.sqs_installation_id;
  }
  if (Object.keys(updatedEntry).length > 0) {
    diskCache.entries[entryKey] = updatedEntry;
    writeDiskCache(diskCache);
  }

  return {
    identity,
    persistEnterprise: !fetchPlan.enterprise || fetchResult.resolved.enterprise,
  };
}
