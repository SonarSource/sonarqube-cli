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

// Records a resolved auth into state.auth.connections like `sonar auth login` does, minus saveToken().

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { getToken } from '@/core/host/keychain.ts';
import logger from '@/core/observability/logger.ts';
import { cloudRegionFromUrl } from '@/core/server/sonarcloud-region.ts';

import type { AuthConnection } from '../state/state.ts';
import {
  addOrUpdateConnection,
  authMatchesConnection,
  getActiveConnection,
} from '../state/state-manager.ts';
import { loadState, updateState } from '../state/state-repository.ts';
import {
  EMPTY_IDENTITY,
  identityFromConnection,
  needsIdentityEnrichment,
  resolveTelemetryIdentity,
  type TelemetryIdentity,
} from '../telemetry/identity-fetch.ts';

export interface RecordConnectionOptions {
  /** Only browser-OAuth logins carry a token name — env-var auth never does. */
  tokenName?: string;
  /** Bypasses the no-op check below to always refresh. */
  force?: boolean;
  /** Ignores identity inherited from the active connection and resolves it for this token. */
  refreshIdentity?: boolean;
}

/** No-ops when `auth` already matches a fully-enriched active connection. */
export async function recordConnectionFromAuth(
  auth: ResolvedAuth,
  options: RecordConnectionOptions = {},
): Promise<AuthConnection> {
  const state = loadState();
  const active = getActiveConnection(state);
  const seedConnection =
    active !== undefined && authMatchesConnection(auth, active) ? active : undefined;
  const seedIdentity = options.refreshIdentity
    ? EMPTY_IDENTITY
    : identityFromConnection(seedConnection);
  const storedToken = auth.comesFromEnv() ? await readStoredToken(auth) : null;

  if (
    !options.force &&
    seedConnection &&
    !needsIdentityEnrichment(seedIdentity, auth.connectionType, seedConnection)
  ) {
    if (auth.comesFromEnv()) {
      const envOnly = shouldRecordEnvOnly(auth, seedConnection, storedToken);
      if (seedConnection.envOnly === (envOnly || undefined)) {
        return seedConnection;
      }
      return updateState((latest) => {
        const connection = getActiveConnection(latest);
        if (connection?.id === seedConnection.id && authMatchesConnection(auth, connection)) {
          syncEnvOnly(auth, connection, storedToken);
          return connection;
        }
        return seedConnection;
      });
    }
    return seedConnection;
  }

  const identity = await resolveTelemetryIdentity(auth, seedIdentity);
  return updateState((latest) => {
    const activeConnection = getActiveConnection(latest);
    const matchingConnection =
      activeConnection && authMatchesConnection(auth, activeConnection)
        ? activeConnection
        : undefined;
    const connection = addOrUpdateConnection(latest, auth.serverUrl, auth.connectionType, {
      orgKey: auth.orgKey,
      region: cloudRegionFromUrl(auth.serverUrl),
      tokenName: resolveRecordedTokenName(auth, options, matchingConnection?.tokenName),
      envOnly: shouldRecordEnvOnly(auth, matchingConnection, storedToken),
    });
    applyIdentityToConnection(connection, auth, identity);
    return connection;
  });
}

function resolveRecordedTokenName(
  auth: ResolvedAuth,
  options: RecordConnectionOptions,
  seedTokenName: string | undefined,
): string | undefined {
  if ('tokenName' in options) {
    return options.tokenName;
  }
  if (auth.comesFromEnv()) {
    return seedTokenName;
  }
  return undefined;
}

function shouldRecordEnvOnly(
  auth: ResolvedAuth,
  connection: AuthConnection | undefined,
  storedToken: string | null,
): boolean {
  return (
    auth.comesFromEnv() &&
    (connection === undefined || connection.envOnly === true) &&
    storedToken !== auth.token
  );
}

function syncEnvOnly(
  auth: ResolvedAuth,
  connection: AuthConnection,
  storedToken: string | null,
): void {
  if (shouldRecordEnvOnly(auth, connection, storedToken)) {
    connection.envOnly = true;
  } else {
    delete connection.envOnly;
  }
}

async function readStoredToken(auth: ResolvedAuth): Promise<string | null> {
  try {
    return await getToken(auth.serverUrl);
  } catch (err) {
    logger.debug(`Keychain unavailable while recording connection: ${(err as Error).message}`);
    return null;
  }
}

/** Applies fetched identity fields to the connection, per connection type. */
function applyIdentityToConnection(
  connection: AuthConnection,
  auth: ResolvedAuth,
  identity: TelemetryIdentity,
): void {
  connection.userUuid = identity.user_uuid;
  if (auth.connectionType === 'cloud' && auth.orgKey) {
    connection.organizationUuidV4 = identity.organization_uuid_v4;
    if (identity.enterprise_uuid !== undefined) {
      connection.enterpriseUuid = identity.enterprise_uuid;
    }
  } else if (auth.connectionType === 'on-premise') {
    connection.sqsInstallationId = identity.sqs_installation_id;
  }
}
