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

import { getToken as getKeystoreToken } from '../../../lib/keychain';
import { loadState } from '../../../lib/state-manager';
import { note, print, withSpinner } from '../../../ui';
import { NOTE_STYLES } from '../../../ui/colors';
import { CommandFailedError } from '../_common/error';
import type { TokenStatus } from '../_common/token';
import { checkTokenStatus } from '../_common/token';

function connectionLines(serverUrl: string, orgKey: string | undefined): string[] {
  return [`Server  ${serverUrl}`, ...(orgKey ? [`Org     ${orgKey}`] : [])];
}

function displayTokenMissing(serverUrl: string, orgKey: string | undefined): void {
  note(
    [...connectionLines(serverUrl, orgKey), '', 'Run "sonar auth login" to restore the token'],
    '✗ Token missing',
    NOTE_STYLES.error,
  );
}

function displayTokenStatus(
  serverUrl: string,
  orgKey: string | undefined,
  status: TokenStatus,
): void {
  const lines = connectionLines(serverUrl, orgKey);

  if (status === 'valid') {
    note(lines, '✓ Connected', NOTE_STYLES.success);
  } else if (status === 'invalid') {
    note(
      [...lines, '', 'Run "sonar auth login" to reauthenticate'],
      '✗ Token invalid',
      NOTE_STYLES.error,
    );
  } else {
    note(
      [...lines, '', 'Could not connect to the server to verify the token'],
      '⚠ Cannot reach server',
      NOTE_STYLES.warn,
    );
  }
}

export async function authStatus(): Promise<void> {
  const state = loadState();

  if (state.auth.connections.length === 0) {
    print('No saved connection');
    throw new CommandFailedError('Authentication check failed');
  }

  const conn = state.auth.connections[0];
  const token = await getKeystoreToken(conn.serverUrl, conn.orgKey);

  if (token === null) {
    displayTokenMissing(conn.serverUrl, conn.orgKey);
    throw new CommandFailedError('Authentication check failed');
  }

  const status = await withSpinner('Verifying token...', () =>
    checkTokenStatus(conn.serverUrl, token),
  );
  displayTokenStatus(conn.serverUrl, conn.orgKey, status);

  if (status === 'unreachable') throw new CommandFailedError('Connection check failed');
  if (status !== 'valid') throw new CommandFailedError('Authentication check failed');
}
