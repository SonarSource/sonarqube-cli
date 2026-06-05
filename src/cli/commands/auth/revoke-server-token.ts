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

import type { AuthConnection } from '../../../lib/state';
import { SonarQubeClient } from '../../../sonarqube/client';
import { warn } from '../../../ui';

export type RevokeServerTokenContext = 'logout' | 'reset';

/**
 * Attempt to revoke the server-side token before local cleanup.
 * Best-effort: warns and returns on failure so that local cleanup always proceeds.
 */
export async function revokeServerTokenIfPossible(
  connection: AuthConnection,
  token: string | undefined,
  context: RevokeServerTokenContext = 'logout',
): Promise<void> {
  if (!connection.tokenName) {
    warn(
      'The server-side token name is unknown for this connection, so the token could not be revoked automatically. Revoke it manually on the server if needed.',
    );
    return;
  }

  if (!token) {
    warn(
      `Could not retrieve the local token from the keychain, so the server-side token "${connection.tokenName}" could not be revoked automatically. Revoke it manually on the server if needed.`,
    );
    return;
  }

  try {
    await new SonarQubeClient(connection.serverUrl, token).revokeUserToken(connection.tokenName);
  } catch (error) {
    const detail = (error as Error).message;
    if (context === 'logout') {
      warn(
        `Failed to revoke the server-side token "${connection.tokenName}": ${detail}. Continuing with local logout.`,
      );
      return;
    }
    warn(
      `Failed to revoke the server-side token "${connection.tokenName}" for ${connection.serverUrl}: ${detail}`,
    );
  }
}
