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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CommandFailedError } from '../../../../../src/cli/commands/_common/error';
import * as revokeServerToken from '../../../../../src/cli/commands/auth/revoke-server-token';
import { purgeAuth } from '../../../../../src/cli/commands/system/reset-auth';
import * as keychain from '../../../../../src/lib/keychain';
import type { CliState } from '../../../../../src/lib/state';
import { getDefaultState } from '../../../../../src/lib/state';

function stateWithConnection(
  overrides: Partial<CliState['auth']['connections'][number]> = {},
): CliState {
  const state = getDefaultState('test');
  state.auth.isAuthenticated = true;
  state.auth.connections = [
    {
      id: 'conn-1',
      serverUrl: 'https://sonarcloud.io',
      orgKey: 'sonarsource',
      type: 'cloud',
      region: 'eu',
      tokenName: 'SonarQube CLI 9',
      authenticatedAt: new Date().toISOString(),
      ...overrides,
    },
  ];
  state.auth.activeConnectionId = 'conn-1';
  return state;
}

describe('purgeAuth', () => {
  afterEach(() => {
    spyOn(keychain, 'getToken').mockRestore();
    spyOn(keychain, 'deleteToken').mockRestore();
    spyOn(revokeServerToken, 'revokeServerTokenIfPossible').mockRestore();
    spyOn(revokeServerToken, 'reportRevokeServerTokenOutcome').mockRestore();
  });

  beforeEach(() => {
    spyOn(revokeServerToken, 'revokeServerTokenIfPossible').mockResolvedValue({
      status: 'success',
    });
    spyOn(revokeServerToken, 'reportRevokeServerTokenOutcome').mockImplementation(() => {});
  });

  it('clears state and deletes keychain entries when all steps succeed', async () => {
    const getTokenSpy = spyOn(keychain, 'getToken').mockResolvedValue('squ_token');
    const deleteTokenSpy = spyOn(keychain, 'deleteToken').mockResolvedValue(undefined);

    const result = await purgeAuth(stateWithConnection());

    expect(result.authConnectionIds).toEqual(['conn-1']);
    expect(result.item.status).toBe('done');
    expect(getTokenSpy).toHaveBeenCalledWith('https://sonarcloud.io', 'sonarsource');
    expect(deleteTokenSpy).toHaveBeenCalledWith('https://sonarcloud.io', 'sonarsource');
  });

  it('still clears state when keychain read fails but delete succeeds', async () => {
    spyOn(keychain, 'getToken').mockRejectedValue(
      new CommandFailedError('Failed to access the system keychain.'),
    );
    const deleteTokenSpy = spyOn(keychain, 'deleteToken').mockResolvedValue(undefined);

    const result = await purgeAuth(stateWithConnection());

    expect(result.authConnectionIds).toEqual(['conn-1']);
    expect(result.item.status).toBe('warn');
    expect(result.item.detail).toContain('could not read keychain entry');
    expect(deleteTokenSpy).toHaveBeenCalledWith('https://sonarcloud.io', 'sonarsource');
  });

  it('still clears state when keychain delete fails after a successful read', async () => {
    spyOn(keychain, 'getToken').mockResolvedValue('squ_token');
    spyOn(keychain, 'deleteToken').mockRejectedValue(
      new CommandFailedError('Failed to access the system keychain.'),
    );

    const result = await purgeAuth(stateWithConnection());

    expect(result.authConnectionIds).toEqual(['conn-1']);
    expect(result.item.status).toBe('warn');
    expect(result.item.detail).toContain('could not delete keychain entry');
  });

  it('still attempts delete when read fails', async () => {
    spyOn(keychain, 'getToken').mockRejectedValue(
      new CommandFailedError('Failed to access the system keychain.'),
    );
    const deleteTokenSpy = spyOn(keychain, 'deleteToken').mockResolvedValue(undefined);

    await purgeAuth(stateWithConnection());

    expect(deleteTokenSpy).toHaveBeenCalledTimes(1);
  });
});
