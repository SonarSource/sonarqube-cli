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

import { deleteToken, getToken } from '../../../lib/keychain';
import type { AuthConnection } from '../../../lib/state';
import { getActiveConnection, loadState, saveState } from '../../../lib/state-manager';
import { SonarQubeClient } from '../../../sonarqube/client';
import { print, success, warn } from '../../../ui';

/**
 * Attempt to revoke the server-side token before local cleanup.
 * Best-effort: warns and returns on failure so that local logout always proceeds.
 */
async function revokeServerTokenIfPossible(
  active: AuthConnection,
  token: string | undefined,
): Promise<void> {
  if (!active.tokenName) {
    warn(
      'The server-side token name is unknown for this connection, so the token could not be revoked automatically. Revoke it manually on the server if needed.',
    );
    return;
  }

  if (!token) {
    warn(
      `Could not retrieve the local token from the keychain, so the server-side token "${active.tokenName}" could not be revoked automatically. Revoke it manually on the server if needed.`,
    );
    return;
  }

  try {
    await new SonarQubeClient(active.serverUrl, token).revokeUserToken(active.tokenName);
  } catch (error) {
    warn(
      `Failed to revoke the server-side token "${active.tokenName}": ${(error as Error).message}. Continuing with local logout.`,
    );
  }
}

/**
 * Logout command - remove token from keychain
 */
export async function authLogout(): Promise<void> {
  const state = loadState();
  const active = getActiveConnection(state);

  if (!state.auth.isAuthenticated || active === undefined || state.auth.connections.length === 0) {
    print('You are already logged out.');
    return;
  }

  const server = active.serverUrl;
  const org = active.orgKey;
  const token = (await getToken(server, org)) ?? undefined;

  await revokeServerTokenIfPossible(active, token);

  await deleteToken(server, org);

  state.auth.connections = state.auth.connections.filter((c) => c.id !== active.id);

  state.auth.activeConnectionId = undefined;

  state.auth.isAuthenticated = false;

  saveState(state);

  const displayServerLogout =
    active.type === 'cloud' && org !== undefined ? `${server} (${org})` : server;
  success(`Logged out from: ${displayServerLogout}`);
}
