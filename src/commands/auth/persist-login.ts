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

import { recordConnectionFromAuth } from '@/core/auth/auth-connection-recorder.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import {
  deleteStaleTokens,
  getToken as getKeystoreToken,
  normalizeServerUrl,
  saveToken,
} from '@/core/host/keychain.ts';
import { cloudRegionFromUrl } from '@/core/server/sonarcloud-region.ts';
import type { AuthConnection } from '@/core/state/state.ts';
import { addOrUpdateConnection, getActiveConnection } from '@/core/state/state-manager.ts';
import { loadState, updateState } from '@/core/state/state-repository.ts';
import type { Console } from '@/core/ui/console.ts';

import {
  reportRevokeServerTokenOutcome,
  revokeServerTokenIfPossible,
} from './revoke-server-token.ts';

interface PersistLoginOptions {
  tokenName?: string;
  refreshIdentity?: boolean;
  console?: Console;
}

export async function persistLoginCredentials(
  server: string,
  isCloud: boolean,
  org: string | undefined,
  token: string,
  options: PersistLoginOptions = {},
): Promise<void> {
  const state = loadState();
  await revokePreviousLoginToken(getActiveConnection(state), server, token, options);

  await deleteStaleTokens(state.auth.connections, server);
  await saveToken(server, token);

  const actualToken = token || (await getKeystoreToken(server));

  if (actualToken) {
    try {
      await recordConnectionFromAuth(
        new ResolvedAuth({
          token: actualToken,
          serverUrl: server,
          orgKey: org,
          connectionType: isCloud ? 'cloud' : 'on-premise',
          source: 'state',
        }),
        {
          tokenName: options.tokenName,
          force: true,
          refreshIdentity: options.refreshIdentity,
        },
      );
    } catch (error) {
      throw new CommandFailedError(
        `Token saved, but login state could not be updated: ${String(error)}`,
      );
    }
    return;
  }

  try {
    updateState((latest) => {
      addOrUpdateConnection(latest, server, isCloud ? 'cloud' : 'on-premise', {
        orgKey: org,
        region: cloudRegionFromUrl(server),
        tokenName: options.tokenName,
      });
    });
  } catch (error) {
    throw new CommandFailedError(
      `Token saved, but login state could not be updated: ${String(error)}`,
    );
  }
}

export function isSameServer(connection: AuthConnection | undefined, server: string): boolean {
  return (
    connection !== undefined &&
    normalizeServerUrl(connection.serverUrl) === normalizeServerUrl(server)
  );
}

async function revokePreviousLoginToken(
  connection: AuthConnection | undefined,
  server: string,
  token: string,
  options: PersistLoginOptions,
): Promise<void> {
  if (!connection?.tokenName || !isSameServer(connection, server)) {
    return;
  }
  const previousToken = await getKeystoreToken(server);
  if (!previousToken || previousToken === token) {
    return;
  }
  const outcome = await revokeServerTokenIfPossible(
    { serverUrl: server, tokenName: connection.tokenName },
    previousToken,
  );
  if (options.console) {
    reportRevokeServerTokenOutcome(outcome, {
      continuingMessage: 'Continuing with login.',
      console: options.console,
    });
  }
}
