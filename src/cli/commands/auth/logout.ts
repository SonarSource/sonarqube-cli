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
import logger from '../../../lib/logger';
import { getActiveConnection, loadState, saveState } from '../../../lib/state-manager';
import { SonarQubeClient } from '../../../sonarqube/client';
import { print, success, warn } from '../../../ui';

/**
 * Logout command - revoke token on the server (best-effort) and remove it from the keychain.
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

  // Revoke on the server before wiping the keychain: the API call needs the token as Bearer auth.
  // Only possible when we captured the token name from the OAuth callback at login time.
  if (active.tokenName) {
    const token = await getToken(server, org);
    if (token) {
      try {
        await new SonarQubeClient(server, token).revokeUserToken(active.tokenName);
      } catch (error) {
        logger.debug(`Failed to revoke token on server: ${(error as Error).message}`);
        warn(
          'Could not revoke token on the server. You may revoke it manually in your SonarQube account security settings.',
        );
      }
    }
  } else {
    print(
      'Token name is not known locally, skipping server-side revocation. You may revoke it manually in your SonarQube account security settings.',
    );
  }

  await deleteToken(server, org);

  state.auth.connections = state.auth.connections.filter((c) => c.id !== active.id);

  state.auth.activeConnectionId = undefined;

  state.auth.isAuthenticated = false;

  saveState(state);

  const displayServerLogout =
    active.type === 'cloud' && org !== undefined ? `${server} (${org})` : server;
  success(`Logged out from: ${displayServerLogout}`);
}
