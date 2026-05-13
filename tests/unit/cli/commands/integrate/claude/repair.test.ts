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

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';

import * as token from '../../../../../../src/cli/commands/_common/token';
import { repairToken } from '../../../../../../src/cli/commands/integrate/claude/repair';
import * as keychain from '../../../../../../src/lib/keychain';
import type { CliState } from '../../../../../../src/lib/state';
import { getDefaultState } from '../../../../../../src/lib/state';
import * as stateManager from '../../../../../../src/lib/state-manager';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../../src/ui';

const SERVER_URL = 'https://sonarqube.example.com';
const NEW_TOKEN = 'new-generated-token';
const NEW_TOKEN_NAME = 'cli-browser-repaired';
const STALE_TOKEN_NAME = 'cli-browser-stale';

function makeStateWithConnection(options?: { tokenName?: string; orgKey?: string }): CliState {
  const state = getDefaultState('test');
  const connectionId = 'test-connection-id';
  state.auth.isAuthenticated = true;
  state.auth.activeConnectionId = connectionId;
  state.auth.connections = [
    {
      id: connectionId,
      type: options?.orgKey ? 'cloud' : 'on-premise',
      serverUrl: SERVER_URL,
      orgKey: options?.orgKey,
      tokenName: options?.tokenName,
      authenticatedAt: new Date().toISOString(),
    },
  ];
  return state;
}

describe('repairToken', () => {
  let generateTokenSpy: Mock<
    Extract<(typeof token)['generateTokenViaBrowser'], (...args: any[]) => any>
  >;
  let validateTokenSpy: Mock<Extract<(typeof token)['validateToken'], (...args: any[]) => any>>;
  let saveTokenSpy: Mock<Extract<(typeof keychain)['saveToken'], (...args: any[]) => any>>;
  let deleteTokenSpy: Mock<Extract<(typeof keychain)['deleteToken'], (...args: any[]) => any>>;
  let loadStateSpy: Mock<Extract<(typeof stateManager)['loadState'], (...args: any[]) => any>>;
  let saveStateSpy: Mock<Extract<(typeof stateManager)['saveState'], (...args: any[]) => any>>;

  beforeEach(() => {
    setMockUi(true);
    generateTokenSpy = spyOn(token, 'generateTokenViaBrowser').mockResolvedValue({
      token: NEW_TOKEN,
      tokenName: NEW_TOKEN_NAME,
    });
    validateTokenSpy = spyOn(token, 'validateToken').mockResolvedValue(true);
    saveTokenSpy = spyOn(keychain, 'saveToken').mockResolvedValue(undefined);
    deleteTokenSpy = spyOn(keychain, 'deleteToken').mockResolvedValue(undefined);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(makeStateWithConnection());
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    generateTokenSpy.mockRestore();
    validateTokenSpy.mockRestore();
    saveTokenSpy.mockRestore();
    deleteTokenSpy.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
  });

  it('shows "Obtaining access token..." text message', async () => {
    await repairToken(SERVER_URL);

    const msg = getMockUiCalls().find(
      (c) => c.method === 'text' && String(c.args[0]) === 'Obtaining access token...',
    );
    expect(msg).toBeDefined();
  });

  it('shows "Token saved to keychain" success message', async () => {
    await repairToken(SERVER_URL);

    const msg = getMockUiCalls().find(
      (c) => c.method === 'success' && String(c.args[0]) === 'Token saved to keychain',
    );
    expect(msg).toBeDefined();
  });

  it('generates a new token via browser using the provided server URL', async () => {
    await repairToken(SERVER_URL);

    expect(generateTokenSpy).toHaveBeenCalledTimes(1);
    expect(generateTokenSpy).toHaveBeenCalledWith(SERVER_URL);
  });

  it('returns the newly generated token', async () => {
    const actual = await repairToken(SERVER_URL);

    expect(actual).toBe(NEW_TOKEN);
  });

  it('validates the generated token against the server', async () => {
    await repairToken(SERVER_URL);

    expect(validateTokenSpy).toHaveBeenCalledTimes(1);
    expect(validateTokenSpy).toHaveBeenCalledWith(SERVER_URL, NEW_TOKEN);
  });

  it('throws when the generated token fails validation', async () => {
    validateTokenSpy.mockResolvedValue(false);

    let caughtError: unknown;
    try {
      await repairToken(SERVER_URL);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error | undefined)?.message).toBe('Generated token is invalid.');
    expect((caughtError as { remediationHint?: string } | undefined)?.remediationHint).toBe(
      "Rerun the browser login flow or authenticate again with '--with-token'.",
    );
  });

  it('does not save the token when validation fails', async () => {
    validateTokenSpy.mockResolvedValue(false);

    const actual = repairToken(SERVER_URL);

    await actual.catch(() => {});
    expect(saveTokenSpy).not.toHaveBeenCalled();
  });

  it('deletes the old token with the provided organization', async () => {
    await repairToken(SERVER_URL, 'my-org');

    expect(deleteTokenSpy).toHaveBeenCalledTimes(1);
    expect(deleteTokenSpy).toHaveBeenCalledWith(SERVER_URL, 'my-org');
  });

  it('deletes the old token without organization when none is provided', async () => {
    await repairToken(SERVER_URL);

    expect(deleteTokenSpy).toHaveBeenCalledWith(SERVER_URL, undefined);
  });

  it('continues and saves the new token even when deleteToken throws', async () => {
    deleteTokenSpy.mockRejectedValue(new Error('keychain unavailable'));

    await repairToken(SERVER_URL);

    expect(saveTokenSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when deleteToken fails', async () => {
    deleteTokenSpy.mockRejectedValue(new Error('keychain locked'));

    const actual = await repairToken(SERVER_URL);

    expect(actual).toBe(NEW_TOKEN);
  });

  it('saves the new token to the keychain with the provided organization', async () => {
    await repairToken(SERVER_URL, 'my-org');

    expect(saveTokenSpy).toHaveBeenCalledTimes(1);
    expect(saveTokenSpy).toHaveBeenCalledWith(SERVER_URL, NEW_TOKEN, 'my-org');
  });

  it('saves the new token to the keychain without organization when none is provided', async () => {
    await repairToken(SERVER_URL);

    expect(saveTokenSpy).toHaveBeenCalledWith(SERVER_URL, NEW_TOKEN, undefined);
  });

  it('persists the freshly-minted tokenName on the active connection', async () => {
    const state = makeStateWithConnection({ tokenName: STALE_TOKEN_NAME });
    loadStateSpy.mockReturnValue(state);

    await repairToken(SERVER_URL);

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    expect(state.auth.connections[0].tokenName).toBe(NEW_TOKEN_NAME);
  });

  it('clears a stale tokenName when the repaired browser callback returns no name', async () => {
    generateTokenSpy.mockResolvedValue({ token: NEW_TOKEN });
    const state = makeStateWithConnection({ tokenName: STALE_TOKEN_NAME });
    loadStateSpy.mockReturnValue(state);

    await repairToken(SERVER_URL);

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    expect(state.auth.connections[0].tokenName).toBeUndefined();
  });

  it('does not touch state when the active connection does not match', async () => {
    const state = makeStateWithConnection({ tokenName: STALE_TOKEN_NAME });
    // Simulate the active connection being for a different server than the one we're repairing.
    state.auth.connections[0].serverUrl = 'https://other-server.example.com';
    loadStateSpy.mockReturnValue(state);

    await repairToken(SERVER_URL);

    expect(saveStateSpy).not.toHaveBeenCalled();
    expect(state.auth.connections[0].tokenName).toBe(STALE_TOKEN_NAME);
  });
});
