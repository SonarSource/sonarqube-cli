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

import { deleteToken, getToken } from '../../../lib/keychain';
import type { AuthConnection, CliState } from '../../../lib/state';
import { SonarQubeClient } from '../../../sonarqube/client';
import type { PhaseItem } from '../../../ui';
import { phaseItem, warn } from '../../../ui';

export interface AuthResetResult {
  item: PhaseItem;
  authConnectionIds: string[];
}

async function revokeServerTokenIfPossible(
  connection: AuthConnection,
  token: string | undefined,
): Promise<void> {
  if (!connection.tokenName) {
    return;
  }

  if (!token) {
    return;
  }

  try {
    await new SonarQubeClient(connection.serverUrl, token).revokeUserToken(connection.tokenName);
  } catch (error) {
    warn(
      `Failed to revoke server-side token "${connection.tokenName}" for ${connection.serverUrl}: ${(error as Error).message}`,
    );
  }
}

export async function purgeAuth(state: CliState): Promise<AuthResetResult> {
  const cleanedIds: string[] = [];
  const failed: string[] = [];

  for (const conn of state.auth.connections) {
    const target = conn.orgKey ? `${conn.serverUrl} (${conn.orgKey})` : conn.serverUrl;
    try {
      const token = (await getToken(conn.serverUrl, conn.orgKey)) ?? undefined;
      await revokeServerTokenIfPossible(conn, token);
      await deleteToken(conn.serverUrl, conn.orgKey);
      cleanedIds.push(conn.id);
    } catch (err) {
      failed.push(`${target}: ${(err as Error).message}`);
    }
  }

  let item: PhaseItem;
  if (failed.length > 0) {
    const counts =
      cleanedIds.length > 0
        ? `${cleanedIds.length} removed, ${failed.length} failed`
        : `${failed.length} failed`;
    item = phaseItem('Authentication', 'warn', `${counts}: ${failed.join('; ')}`);
  } else {
    item = phaseItem(
      'Authentication',
      'done',
      `${cleanedIds.length} tokens removed from keychain.`,
    );
  }

  return { item, authConnectionIds: cleanedIds };
}
