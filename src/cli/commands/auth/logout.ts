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

import { deleteToken } from '../../../cli/commands/_common/token';
import { getActiveConnection, loadState, saveState } from '../../../lib/state-manager';
import { print, success } from '../../../ui';

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

  await deleteToken(server, org);

  state.auth.connections = state.auth.connections.filter((c) => c.id !== active.id);

  state.auth.activeConnectionId = undefined;

  state.auth.isAuthenticated = false;

  saveState(state);

  const displayServerLogout =
    active.type === 'cloud' && org !== undefined ? `${server} (${org})` : server;
  success(`Logged out from: ${displayServerLogout}`);
}
