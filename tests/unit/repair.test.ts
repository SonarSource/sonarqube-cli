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

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';
import { repairToken } from '../../src/cli/commands/integrate/claude/repair';
import * as token from '../../src/cli/commands/_common/token';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../src/ui';

const SERVER_URL = 'https://sonarqube.example.com';
const NEW_TOKEN = 'new-generated-token';

describe('repairToken', () => {
  let generateTokenSpy: Mock<
    Extract<(typeof token)['generateTokenViaBrowser'], (...args: any[]) => any>
  >;
  let validateTokenSpy: Mock<Extract<(typeof token)['validateToken'], (...args: any[]) => any>>;
  let saveTokenSpy: Mock<Extract<(typeof token)['saveToken'], (...args: any[]) => any>>;
  let deleteTokenSpy: Mock<Extract<(typeof token)['deleteToken'], (...args: any[]) => any>>;

  beforeEach(() => {
    setMockUi(true);
    generateTokenSpy = spyOn(token, 'generateTokenViaBrowser').mockResolvedValue(NEW_TOKEN);
    validateTokenSpy = spyOn(token, 'validateToken').mockResolvedValue(true);
    saveTokenSpy = spyOn(token, 'saveToken').mockResolvedValue(undefined);
    deleteTokenSpy = spyOn(token, 'deleteToken').mockResolvedValue(undefined);
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    generateTokenSpy.mockRestore();
    validateTokenSpy.mockRestore();
    saveTokenSpy.mockRestore();
    deleteTokenSpy.mockRestore();
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

  it('throws when the generated token fails validation', () => {
    validateTokenSpy.mockResolvedValue(false);

    const actual = repairToken(SERVER_URL);

    expect(actual).rejects.toThrow('Generated token is invalid');
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
});
