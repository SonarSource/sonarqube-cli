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

import { getAllCredentials, purgeAllTokens } from '../../../lib/keychain';
import { loadState, saveState } from '../../../lib/state-manager';
import { confirmPrompt, print, success } from '../../../ui';

/**
 * Purge command - remove all tokens from keychain
 */
export async function authPurge(): Promise<void> {
  const credentials = await getAllCredentials();

  if (credentials.length === 0) {
    print('No tokens found in keychain');
    return;
  }

  print(`Found ${credentials.length} token(s):`);
  credentials.forEach((cred) => {
    print(`  - ${cred.account}`);
  });
  print('');

  const confirmed = await confirmPrompt('Remove all tokens?');
  if (!confirmed) {
    print('Cancelled');
    return;
  }

  await purgeAllTokens();

  const state = loadState();
  state.auth.connections = [];
  state.auth.activeConnectionId = undefined;
  state.auth.isAuthenticated = false;
  saveState(state);

  success('All tokens have been removed from keychain');
}
