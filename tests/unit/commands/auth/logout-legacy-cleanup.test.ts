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

import { afterEach, expect, it, spyOn } from 'bun:test';

import { authLogout } from '@/commands/auth/logout.ts';
import * as revokeServerToken from '@/commands/auth/revoke-server-token.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import * as keychain from '@/core/host/keychain.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

afterEach(() => {
  spyOn(keychain, 'getToken').mockRestore();
  spyOn(keychain, 'deleteToken').mockRestore();
  spyOn(keychain, 'deleteLegacyTokens').mockRestore();
  spyOn(revokeServerToken, 'revokeServerTokenIfPossible').mockRestore();
  spyOn(revokeServerToken, 'reportRevokeServerTokenOutcome').mockRestore();
  spyOn(stateRepository, 'loadState').mockRestore();
  spyOn(stateRepository, 'saveState').mockRestore();
});

it('reports partial legacy removal and still completes logout', async () => {
  const state = getDefaultState('test');
  state.auth.isAuthenticated = true;
  state.auth.connections = [
    {
      id: 'conn-1',
      serverUrl: 'https://sonarcloud.io',
      orgKey: 'sonarsource',
      type: 'cloud',
      region: 'eu',
      authenticatedAt: new Date().toISOString(),
    },
  ];
  state.auth.activeConnectionId = 'conn-1';
  spyOn(stateRepository, 'loadState').mockReturnValue(state);
  spyOn(stateRepository, 'saveState').mockImplementation(() => {});
  spyOn(keychain, 'getToken').mockResolvedValue(null);
  spyOn(keychain, 'deleteToken').mockResolvedValue(undefined);
  spyOn(keychain, 'deleteLegacyTokens').mockResolvedValue({
    removed: true,
    errors: [new Error('Keychain is locked')],
  });
  spyOn(revokeServerToken, 'revokeServerTokenIfPossible').mockResolvedValue({ status: 'success' });
  spyOn(revokeServerToken, 'reportRevokeServerTokenOutcome').mockImplementation(() => {});
  const console = new FakeConsole();

  await authLogout(new CommandInvocationContext(console));

  expect(
    console.findCall('warn', 'A token stored before this upgrade may still be valid'),
  ).toBeDefined();
  expect(console.findCall('warn', 'Could not delete the pre-upgrade local token')).toBeDefined();
  expect(console.findCall('success', 'Logged out')).toBeDefined();
  expect(state.auth.connections).toHaveLength(0);
});
