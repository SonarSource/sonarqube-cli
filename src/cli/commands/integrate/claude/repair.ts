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

// Repair orchestrator - fixes configuration issues

import { deleteToken, saveToken } from '../../../../lib/keychain';
import logger from '../../../../lib/logger';
import { getActiveConnection, loadState, saveState } from '../../../../lib/state-manager';
import { success, text } from '../../../../ui';
import { CommandFailedError } from '../../_common/error';
import { generateTokenViaBrowser, validateToken } from '../../_common/token';

export async function repairToken(serverURL: string, organization?: string): Promise<string> {
  text('Obtaining access token...');

  // Generate new token via the browser-OAuth flow. We also capture the
  // server-generated `tokenName` so that a later `sonar auth logout` can
  // revoke exactly this token on the server side (see CLI-75).
  const authResult = await generateTokenViaBrowser(serverURL);
  const newToken = authResult.token;

  // Validate new token
  const valid = await validateToken(serverURL, newToken);
  if (!valid) {
    throw new CommandFailedError('Generated token is invalid');
  }

  // Delete old token
  try {
    await deleteToken(serverURL, organization);
  } catch (error) {
    logger.debug(`Failed to delete token during repair: ${(error as Error).message}`);
  }

  // Save to keychain
  await saveToken(serverURL, newToken, organization);

  // Keep state.tokenName in sync with the freshly-saved keychain token.
  persistTokenNameOnActiveConnection(serverURL, organization, authResult.tokenName);

  success('Token saved to keychain');
  return newToken;
}

/**
 * Update the active connection's `tokenName` to match the freshly-minted
 * browser-OAuth token (resets to `undefined` if the callback omitted `name`).
 */
function persistTokenNameOnActiveConnection(
  serverURL: string,
  organization: string | undefined,
  tokenName: string | undefined,
): void {
  const state = loadState();
  const active = getActiveConnection(state);

  // Only update when the active connection actually matches the server/org
  // we just repaired. `integrate claude` is the sole caller and always
  // operates on the active connection, but guard anyway to avoid silently
  // overwriting an unrelated connection if that ever changes.
  if (active?.serverUrl !== serverURL || active.orgKey !== organization) {
    return;
  }

  active.tokenName = tokenName;
  saveState(state);
}
