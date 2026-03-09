/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { deleteToken, getToken as getKeystoreToken } from '../../../cli/commands/_common/token';
import { discoverServer } from '../_common/discovery';
import { generateConnectionId, loadState, saveState } from '../../../lib/state-manager';
import { print, success } from '../../../ui';
import { SONARCLOUD_HOSTNAME, SONARCLOUD_URL } from '../../../lib/config-constants';

/**
 * Check if server is SonarCloud
 */
function isSonarCloud(serverURL: string): boolean {
  try {
    const url = new URL(serverURL);
    return url.hostname === SONARCLOUD_HOSTNAME;
  } catch {
    return false;
  }
}

export interface AuthLogoutOptions {
  server?: string;
  org?: string;
}

/**
 * Logout command - remove token from keychain
 */
export async function authLogout(options: AuthLogoutOptions): Promise<void> {
  let server = options.server;
  if (!server) {
    const configServer = await discoverServer();
    server = configServer || SONARCLOUD_URL;
  }
  const org = options.org;

  if (isSonarCloud(server) && !org) {
    throw new Error('Organization key is required for SonarCloud logout');
  }

  const token = await getKeystoreToken(server, org);
  if (!token) {
    const displayServer = isSonarCloud(server) ? `${server} (${org})` : server;
    print(`No token found for: ${displayServer}`);
    return;
  }

  await deleteToken(server, org);

  const state = loadState();
  const connectionId = generateConnectionId(server, org);
  state.auth.connections = state.auth.connections.filter((c) => c.id !== connectionId);

  if (state.auth.activeConnectionId === connectionId) {
    state.auth.activeConnectionId = state.auth.connections[0]?.id;
  }

  if (state.auth.connections.length === 0) {
    state.auth.isAuthenticated = false;
  }

  saveState(state);

  const displayServerLogout = isSonarCloud(server) ? `${server} (${org})` : server;
  success(`Logged out from: ${displayServerLogout}`);
}
