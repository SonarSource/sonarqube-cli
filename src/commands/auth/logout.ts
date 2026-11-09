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

import { isValidServerUrl } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import { type CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import {
  deleteToken,
  generateKeychainAccount,
  getToken,
  normalizeServerUrl,
} from '@/core/host/keychain.ts';
import { INVALID_SERVER_URL_MESSAGE } from '@/core/server/server-url-validation.ts';
import type { AuthConnection } from '@/core/state/state.ts';
import { getActiveConnection, removeConnection } from '@/core/state/state-manager.ts';
import { loadState, updateState } from '@/core/state/state-repository.ts';
import type { Console } from '@/core/ui/console.ts';

import { httpsTokenDowngradeTarget } from './persist-login.ts';
import {
  reportRevokeServerTokenOutcome,
  revokeServerTokenIfPossible,
} from './revoke-server-token.ts';

export interface AuthLogoutOptions {
  server?: string;
}

export async function authLogout(
  ctx: CommandInvocationContext,
  options: AuthLogoutOptions = {},
): Promise<void> {
  if (options.server !== undefined && !isValidServerUrl(options.server)) {
    throw new InvalidOptionError(INVALID_SERVER_URL_MESSAGE);
  }
  const { console } = ctx;
  const state = loadState();
  const requestedServer =
    options.server === undefined ? undefined : normalizeServerUrl(options.server);
  const selected =
    requestedServer === undefined
      ? getActiveConnection(state)
      : state.auth.connections.find(
          (connection) => normalizeServerUrl(connection.serverUrl) === requestedServer,
        );

  if (selected === undefined || (options.server === undefined && !state.auth.isAuthenticated)) {
    console.print(
      options.server === undefined
        ? 'You are already logged out.'
        : 'No saved connection matches this server.',
    );
    return;
  }

  const server = selected.serverUrl;
  const org = selected.orgKey;
  const connections =
    options.server === undefined
      ? [selected]
      : state.auth.connections.filter(
          (connection) =>
            generateKeychainAccount(connection.serverUrl) === generateKeychainAccount(server),
        );
  await revokeTokenBeforeLogout(selected, state.auth.connections, console);

  try {
    await deleteToken(server);
  } catch (err) {
    console.warn(
      `Could not delete the local token: ${(err as Error).message}. Continuing with local logout.`,
    );
  }

  let removed: boolean;
  try {
    removed = updateState((latest) => {
      let allRemoved = true;
      for (const saved of connections) {
        const current = latest.auth.connections.find((connection) => connection.id === saved.id);
        if (current === undefined) continue;
        if (current.authenticatedAt === saved.authenticatedAt) removeConnection(latest, saved.id);
        else allRemoved = false;
      }
      return allRemoved;
    });
  } catch (error) {
    throw new CommandFailedError(
      `Local token removed, but logout state could not be updated: ${String(error)}`,
    );
  }

  if (!removed) {
    console.warn('Authentication changed during logout. The newer connection was kept in state.');
    return;
  }

  const displayServerLogout =
    selected.type === 'cloud' && org !== undefined ? `${server} (${org})` : server;
  console.success(`Logged out from: ${displayServerLogout}`);
}

async function revokeTokenBeforeLogout(
  connection: AuthConnection,
  savedConnections: readonly AuthConnection[],
  console: Console,
): Promise<void> {
  if (httpsTokenDowngradeTarget(savedConnections, connection.serverUrl) !== undefined) {
    console.warn(
      'The server-side token could not be revoked automatically. Revoke it manually on the server if needed. Continuing with local logout.',
    );
    return;
  }

  let token: string | undefined;
  try {
    token = (await getToken(connection.serverUrl)) ?? undefined;
  } catch (err) {
    console.warn(
      `Could not read the local token: ${(err as Error).message}. Continuing with local logout.`,
    );
  }

  const revokeOutcome = await revokeServerTokenIfPossible(connection, token);
  reportRevokeServerTokenOutcome(revokeOutcome, {
    continuingMessage: 'Continuing with local logout.',
    console,
  });
}
