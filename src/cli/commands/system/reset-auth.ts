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
import type { CliState } from '../../../lib/state';
import type { PhaseItem } from '../../../ui';
import { phaseItem } from '../../../ui';
import { revokeServerTokenIfPossible } from '../auth/revoke-server-token';

export interface AuthResetResult {
  item: PhaseItem;
  authConnectionIds: string[];
}

type ConnectionOutcome =
  | { status: 'cleaned'; connectionId: string }
  | { status: 'failed'; message: string };

export async function purgeAuth(state: CliState): Promise<AuthResetResult> {
  // Delete tokens sequentially: the file-backed keychain (CI/tests) does an
  // unsynchronized read-modify-write of a single JSON store, so concurrent
  // deletions race and can clobber each other. Server-side revocation still
  // fails fast via its own 10s timeout.
  const outcomes: ConnectionOutcome[] = [];
  for (const conn of state.auth.connections) {
    const target = conn.orgKey ? `${conn.serverUrl} (${conn.orgKey})` : conn.serverUrl;
    try {
      const token = (await getToken(conn.serverUrl, conn.orgKey)) ?? undefined;
      await revokeServerTokenIfPossible(conn, token, 'reset');
      await deleteToken(conn.serverUrl, conn.orgKey);
      outcomes.push({ status: 'cleaned', connectionId: conn.id });
    } catch (err) {
      outcomes.push({ status: 'failed', message: `${target}: ${(err as Error).message}` });
    }
  }

  const cleanedIds = outcomes.flatMap((o) => (o.status === 'cleaned' ? [o.connectionId] : []));
  const failed = outcomes.flatMap((o) => (o.status === 'failed' ? [o.message] : []));

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
      `${cleanedIds.length} token${cleanedIds.length === 1 ? '' : 's'} removed from keychain.`,
    );
  }

  return { item, authConnectionIds: cleanedIds };
}
