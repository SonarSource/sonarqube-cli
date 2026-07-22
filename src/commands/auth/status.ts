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

import { blank, note, print, withSpinner } from '@/core/ui';
import { NOTE_STYLES } from '@/core/ui/colors.ts';

import { ENV_ORG, ENV_SERVER, ENV_TOKEN, resolveFromEnv } from '../../lib/auth-resolver.ts';
import { getToken as getKeystoreToken } from '../../lib/keychain.ts';
import { loadState } from '../../lib/repository/state-repository.ts';
import { CommandFailedError } from '../_common/error.ts';
import type { TokenCheckResult } from '../_common/token.ts';
import { checkTokenStatus } from '../_common/token.ts';

function connectionLines(serverUrl: string, orgKey: string | undefined): string[] {
  return [`Server  ${serverUrl}`, ...(orgKey ? [`Org     ${orgKey}`] : [])];
}

function displayTokenMissing(serverUrl: string, orgKey: string | undefined): void {
  note(connectionLines(serverUrl, orgKey), '✗ Token missing', NOTE_STYLES.error);
}

function displayTokenStatus(
  serverUrl: string,
  orgKey: string | undefined,
  result: TokenCheckResult,
): void {
  const lines = connectionLines(serverUrl, orgKey);

  if (result.status === 'valid') {
    printConnected(serverUrl, 'OS Keychain', orgKey);
  } else if (result.status === 'invalid') {
    note(lines, '✗ Token invalid', NOTE_STYLES.error);
  } else {
    const detail = result.errorMessage
      ? `Could not connect to the server to verify the token: ${result.errorMessage}`
      : 'Could not connect to the server to verify the token';
    note([...lines, '', detail], '⚠ Cannot reach server', NOTE_STYLES.warn);
  }
}

export async function authStatus(): Promise<void> {
  const envAuth = resolveFromEnv();
  if (envAuth) {
    let source: string;
    if (envAuth.connectionType === 'cloud') {
      source = process.env[ENV_SERVER]
        ? `env vars:  ${ENV_TOKEN}, ${ENV_ORG}, ${ENV_SERVER}`
        : `env vars:  ${ENV_TOKEN}, ${ENV_ORG}`;
    } else {
      source = `env vars:  ${ENV_TOKEN}, ${ENV_SERVER}`;
    }
    printConnected(envAuth.serverUrl, source, envAuth.orgKey);
    return;
  }

  const state = loadState();

  if (state.auth.connections.length === 0) {
    print('No saved connection');
    throw new CommandFailedError('Authentication check failed.', {
      remediationHint: "Run 'sonar auth login' to authenticate.",
    });
  }

  const conn = state.auth.connections[0];
  const token = await getKeystoreToken(conn.serverUrl, conn.orgKey);

  if (token === null) {
    displayTokenMissing(conn.serverUrl, conn.orgKey);
    throw new CommandFailedError('Authentication check failed.', {
      remediationHint: "Run 'sonar auth login' to restore the token.",
    });
  }

  const status = await withSpinner('Verifying token...', () =>
    checkTokenStatus(conn.serverUrl, token),
  );
  blank();

  displayTokenStatus(conn.serverUrl, conn.orgKey, status);

  if (status.status === 'unreachable') {
    const message = status.errorMessage
      ? `Connection check failed: ${status.errorMessage}`
      : 'Connection check failed.';
    throw new CommandFailedError(message, {
      remediationHint: 'Check the server URL and network connectivity, then retry.',
    });
  }
  if (status.status !== 'valid') {
    throw new CommandFailedError('Authentication check failed.', {
      remediationHint: "Run 'sonar auth login' to reauthenticate.",
    });
  }
}

function printConnected(serverUrl: string, source: string, orgKey?: string): void {
  note(
    [...connectionLines(serverUrl, orgKey), '', `Source  ${source}`],
    '✓ Connected',
    NOTE_STYLES.success,
  );
}
