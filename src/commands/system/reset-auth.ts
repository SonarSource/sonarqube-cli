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

import type { PhaseItem } from '@/core/ui';
import { phaseItem } from '@/core/ui';

import { deleteToken, getToken } from '../../lib/keychain.ts';
import type { AuthConnection, CliState } from '../../lib/state.ts';
import {
  reportRevokeServerTokenOutcome,
  revokeServerTokenIfPossible,
} from '../auth/revoke-server-token.ts';

export interface AuthResetResult {
  item: PhaseItem;
  authConnectionIds: string[];
}

interface ConnectionOutcome {
  connectionId: string;
  keychainWarnings: string[];
}

function formatConnectionTarget(conn: AuthConnection): string {
  return conn.orgKey ? `${conn.serverUrl} (${conn.orgKey})` : conn.serverUrl;
}

function formatKeychainWarning(target: string, operation: 'read' | 'delete', err: unknown): string {
  const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
  return `${target}: could not ${operation} keychain entry (${detail})`;
}

async function purgeConnectionAuth(conn: AuthConnection): Promise<ConnectionOutcome> {
  const target = formatConnectionTarget(conn);
  const keychainWarnings: string[] = [];

  let token: string | undefined;
  try {
    token = (await getToken(conn.serverUrl, conn.orgKey)) ?? undefined;
  } catch (err) {
    keychainWarnings.push(formatKeychainWarning(target, 'read', err));
  }

  const revokeOutcome = await revokeServerTokenIfPossible(conn, token);
  reportRevokeServerTokenOutcome(revokeOutcome, {
    serverUrl: conn.serverUrl,
    continuingMessage: 'Continuing with local reset.',
  });

  try {
    await deleteToken(conn.serverUrl, conn.orgKey);
  } catch (err) {
    keychainWarnings.push(formatKeychainWarning(target, 'delete', err));
  }

  return { connectionId: conn.id, keychainWarnings };
}

function buildKeychainWarningDetail(
  authConnectionIds: string[],
  keychainOperationFailureCount: number,
): string {
  const operationLabel = keychainOperationFailureCount === 1 ? 'operation' : 'operations';

  if (authConnectionIds.length === 0) {
    return `${keychainOperationFailureCount} keychain ${operationLabel} failed`;
  }

  const connectionLabel = authConnectionIds.length === 1 ? 'connection' : 'connections';
  return `${authConnectionIds.length} ${connectionLabel} cleared from state; ${keychainOperationFailureCount} keychain ${operationLabel} failed`;
}

function buildAuthResetPhaseItem(
  authConnectionIds: string[],
  keychainWarnings: string[],
): PhaseItem {
  if (keychainWarnings.length > 0) {
    const counts = buildKeychainWarningDetail(authConnectionIds, keychainWarnings.length);
    return phaseItem('Authentication', 'warn', `${counts}: ${keychainWarnings.join('; ')}`);
  }

  const tokenLabel = authConnectionIds.length === 1 ? 'token' : 'tokens';
  return phaseItem(
    'Authentication',
    'done',
    `${authConnectionIds.length} ${tokenLabel} removed from keychain.`,
  );
}

export async function purgeAuth(state: CliState): Promise<AuthResetResult> {
  // Delete tokens sequentially: the file-backed keychain (CI/tests) does an
  // unsynchronized read-modify-write of a single JSON store, so concurrent
  // deletions race and can clobber each other. Server-side revocation still
  // fails fast via its own 10s timeout.
  const outcomes: ConnectionOutcome[] = [];
  for (const conn of state.auth.connections) {
    outcomes.push(await purgeConnectionAuth(conn));
  }

  const authConnectionIds = outcomes.map((outcome) => outcome.connectionId);
  const keychainWarnings = outcomes.flatMap((outcome) => outcome.keychainWarnings);

  return {
    item: buildAuthResetPhaseItem(authConnectionIds, keychainWarnings),
    authConnectionIds,
  };
}
