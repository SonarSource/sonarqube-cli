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

import { print, success } from '../../core/ui';
import { deleteToken, getToken } from '../../lib/keychain.ts';
import { loadState, saveState } from '../../lib/repository/state-repository.ts';
import { getActiveConnection, removeConnection } from '../../lib/state-manager.ts';
import {
  reportRevokeServerTokenOutcome,
  revokeServerTokenIfPossible,
} from './revoke-server-token.ts';

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

  const revokeOutcome = await revokeServerTokenIfPossible(active, token);
  reportRevokeServerTokenOutcome(revokeOutcome, {
    continuingMessage: 'Continuing with local logout.',
  });

  await deleteToken(server, org);

  removeConnection(state, active.id);

  saveState(state);

  const displayServerLogout =
    active.type === 'cloud' && org !== undefined ? `${server} (${org})` : server;
  success(`Logged out from: ${displayServerLogout}`);
}
