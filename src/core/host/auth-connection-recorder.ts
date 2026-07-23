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

import type { AuthConnection } from '../state/state.ts';
import {
  addOrUpdateConnection,
  authMatchesConnection,
  getActiveConnection,
} from '../state/state-manager.ts';
import { loadState, saveState } from '../state/state-repository.ts';
import type { ResolvedAuth } from './auth-resolver.ts';
import {
  identityFromConnection,
  needsIdentityEnrichment,
  resolveTelemetryIdentity,
} from './identity-fetch.ts';
import { cloudRegionFromUrl } from './sonarcloud-region.ts';

export interface RecordConnectionOptions {
  /** Only browser-OAuth logins carry a token name — env-var auth never does. */
  tokenName?: string;
  /** Bypasses the no-op check below to always refresh. */
  force?: boolean;
  /** Marks the connection as having no keychain entry behind it. */
  envOnly?: boolean;
}

/** No-ops when `auth` already matches a fully-enriched active connection. */
export async function recordConnectionFromAuth(
  auth: ResolvedAuth,
  options: RecordConnectionOptions = {},
): Promise<AuthConnection> {
  const state = loadState();
  const active = getActiveConnection(state);
  const matches = active !== undefined && authMatchesConnection(auth, active);
  const seedConn = matches ? active : undefined;
  const seedIdentity = identityFromConnection(seedConn);

  if (
    !options.force &&
    seedConn &&
    !needsIdentityEnrichment(seedIdentity, auth.connectionType, seedConn)
  ) {
    return seedConn;
  }

  const connection = addOrUpdateConnection(state, auth.serverUrl, auth.connectionType, {
    orgKey: auth.orgKey,
    region: cloudRegionFromUrl(auth.serverUrl),
    tokenName: options.tokenName,
    envOnly: options.envOnly,
  });

  const identity = await resolveTelemetryIdentity(auth, seedIdentity);
  connection.userUuid = identity.user_uuid;
  if (auth.connectionType === 'cloud' && auth.orgKey) {
    connection.organizationUuidV4 = identity.organization_uuid_v4;
  } else if (auth.connectionType === 'on-premise') {
    connection.sqsInstallationId = identity.sqs_installation_id;
  }

  saveState(state);
  return connection;
}
