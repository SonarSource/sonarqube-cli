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

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isEnvBasedAuth,
  type ResolvedAuth,
  resolveFromEndpoint,
  resolveFromEnv,
  resolveFromState,
} from '@/core/host/auth-resolver.ts';
import { SonarQubeClient } from '@/core/server/client.ts';

import { getTelemetryDir } from '../config-constants.ts';
import type { AuthConnection, ServerType, TelemetryConnectionType } from '../state/state.ts';

export interface TelemetryIdentity {
  user_uuid: string | null;
  organization_uuid_v4: string | null;
  sqs_installation_id: string | null;
}

interface CacheEntry {
  userUuid?: string | null;
  organizationUuidV4?: string | null;
  sqsInstallationId?: string | null;
}

interface IdentityCacheFile {
  entries: Record<string, CacheEntry>;
}

interface IdentityFetchPlan {
  user: boolean;
  org: boolean;
  sqs: boolean;
}

const CACHE_FILENAME = 'identity-cache.json';
const TOKEN_FINGERPRINT_HEX_LENGTH = 16;

const EMPTY_IDENTITY: TelemetryIdentity = {
  user_uuid: null,
  organization_uuid_v4: null,
  sqs_installation_id: null,
};

export function identityFromConnection(conn: AuthConnection | undefined): TelemetryIdentity {
  return {
    user_uuid: conn?.userUuid ?? null,
    organization_uuid_v4: conn?.organizationUuidV4 ?? null,
    sqs_installation_id: conn?.sqsInstallationId ?? null,
  };
}

export function authMatchesConnection(auth: ResolvedAuth, conn: AuthConnection): boolean {
  if (auth.serverUrl !== conn.serverUrl) return false;
  if (auth.connectionType === 'cloud' && auth.orgKey !== conn.orgKey) return false;
  return true;
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

function toTelemetryConnectionType(type: ServerType): Exclude<TelemetryConnectionType, null> {
  return type === 'cloud' ? 'sqc' : 'sqs';
}

function matchingConnection(
  conn: AuthConnection | undefined,
  auth: ResolvedAuth | null,
): AuthConnection | undefined {
  if (conn === undefined) return undefined;
  if (auth && !authMatchesConnection(auth, conn)) return undefined;
  return conn;
}

/** Login persists `userUuid` (string or null); undefined means we have not tried yet. */
function connectionUserUuidResolved(conn: AuthConnection | undefined): boolean {
  return conn?.userUuid !== undefined;
}

function needsIdentityEnrichment(
  identity: TelemetryIdentity,
  connectionType: ServerType,
  conn: AuthConnection | undefined,
): boolean {
  if (!isIdentityCompleteForConnection(identity, connectionType)) {
    return true;
  }
  return !identity.user_uuid && !connectionUserUuidResolved(conn);
}

/**
 * Resolves telemetry identity for command events (`storeEvent` postAction).
 * Skips keychain/state auth lookup when the active connection already carries
 * complete UUIDs and env-var auth is not in use.
 */
async function resolveStoreEventTelemetryIdentity(
  conn: AuthConnection | undefined,
): Promise<{ connectionType: TelemetryConnectionType; identity: TelemetryIdentity }> {
  const envAuth = isEnvBasedAuth() ? resolveFromEnv() : null;
  if (envAuth) {
    return resolveCommandTelemetryIdentity(conn, envAuth);
  }

  if (conn) {
    const identity = identityFromConnection(conn);
    if (!needsIdentityEnrichment(identity, conn.type, conn)) {
      return { connectionType: toTelemetryConnectionType(conn.type), identity };
    }
  }

  const auth = await resolveFromState();
  return resolveCommandTelemetryIdentity(conn, auth);
}

/**
 * Like {@link resolveStoreEventTelemetryIdentity}, but never throws — telemetry
 * must not fail an otherwise-successful command.
 */
export async function resolveStoreEventTelemetryIdentitySafely(
  conn: AuthConnection | undefined,
): Promise<{ connectionType: TelemetryConnectionType; identity: TelemetryIdentity }> {
  try {
    return await resolveStoreEventTelemetryIdentity(conn);
  } catch {
    return {
      connectionType: conn ? toTelemetryConnectionType(conn.type) : null,
      identity: identityFromConnection(conn),
    };
  }
}

export async function resolveCommandTelemetryIdentity(
  conn: AuthConnection | undefined,
  auth: ResolvedAuth | null,
): Promise<{ connectionType: TelemetryConnectionType; identity: TelemetryIdentity }> {
  const seedConn = matchingConnection(conn, auth);
  let identity = identityFromConnection(seedConn);
  let connectionType: TelemetryConnectionType = seedConn
    ? toTelemetryConnectionType(seedConn.type)
    : null;

  if (auth) {
    connectionType = toTelemetryConnectionType(auth.connectionType);
    if (needsIdentityEnrichment(identity, auth.connectionType, seedConn)) {
      identity = await resolveTelemetryIdentity(auth, identity);
    }
  }

  return { connectionType, identity };
}

export async function resolveTelemetryIdentity(
  auth: ResolvedAuth,
  seed: TelemetryIdentity = EMPTY_IDENTITY,
): Promise<TelemetryIdentity> {
  const entryKey = cacheKey(auth);
  const diskCache = readDiskCache();
  const diskEntry = entryKey in diskCache.entries ? diskCache.entries[entryKey] : undefined;

  let identity = mergeIdentity(EMPTY_IDENTITY, seed);
  if (diskEntry !== undefined) {
    identity = mergeIdentity(identity, cacheEntryToIdentity(diskEntry));
  }

  const fetchPlan = planFieldsToFetch(auth, identity, diskEntry);
  if (fetchPlanIsComplete(fetchPlan)) {
    return identity;
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
  if (fetchPlan.sqs && fetchResult.resolved.sqs) {
    updatedEntry.sqsInstallationId = identity.sqs_installation_id;
  }
  if (Object.keys(updatedEntry).length > 0) {
    diskCache.entries[entryKey] = updatedEntry;
    writeDiskCache(diskCache);
  }

  return identity;
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
    sqs_installation_id: entry.sqsInstallationId ?? null,
  };
}

function fetchPlanIsComplete(plan: IdentityFetchPlan): boolean {
  return !plan.user && !plan.org && !plan.sqs;
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
    sqs:
      auth.connectionType === 'on-premise' &&
      !identity.sqs_installation_id &&
      !(entry && 'sqsInstallationId' in entry),
  };
}

function mergeIdentity(
  base: TelemetryIdentity,
  partial: Partial<TelemetryIdentity>,
): TelemetryIdentity {
  return {
    user_uuid: partial.user_uuid ?? base.user_uuid,
    organization_uuid_v4: partial.organization_uuid_v4 ?? base.organization_uuid_v4,
    sqs_installation_id: partial.sqs_installation_id ?? base.sqs_installation_id,
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
  let { user_uuid, organization_uuid_v4, sqs_installation_id } = identity;
  const resolved: IdentityFetchPlan = { user: false, org: false, sqs: false };

  if (fetchPlan.user) {
    const user = await fetchUserUuid(client);
    user_uuid = user.value;
    resolved.user = user.resolved;
  }
  if (fetchPlan.org && auth.orgKey) {
    const org = await fetchOrganizationUuid(client, auth.serverUrl, auth.orgKey);
    organization_uuid_v4 = org.value;
    resolved.org = org.resolved;
  }
  if (fetchPlan.sqs) {
    const sqs = await fetchSqsInstallationId(client);
    sqs_installation_id = sqs.value;
    resolved.sqs = sqs.resolved;
  }

  return {
    identity: { user_uuid, organization_uuid_v4, sqs_installation_id },
    resolved,
  };
}

interface FieldFetchResult {
  value: string | null;
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

async function fetchOrganizationUuid(
  client: SonarQubeClient,
  serverUrl: string,
  orgKey: string,
): Promise<FieldFetchResult> {
  try {
    const endpoint = '/organizations/organizations';
    const { response, value } = await client.getSafe<Array<{ uuidV4: string }>>(
      endpoint,
      { organizationKey: orgKey, excludeEligibility: 'true' },
      resolveFromEndpoint(serverUrl, endpoint),
    );
    if (!response.ok) {
      return { value: null, resolved: false };
    }
    return { value: value?.[0]?.uuidV4 ?? null, resolved: true };
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
