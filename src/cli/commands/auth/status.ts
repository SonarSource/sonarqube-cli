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

import { getToken as getKeystoreToken } from '../../../cli/commands/_common/token';
import { loadState } from '../../../lib/state-manager';
import { note, print } from '../../../ui';
import { dim, green, red } from '../../../ui/colors';

/**
 * Show active authentication connection with token verification
 */
export async function authStatus(): Promise<void> {
  const state = loadState();

  if (state.auth.connections.length === 0) {
    print('No saved connection');
    return;
  }

  const conn = state.auth.connections[0];
  const token = await getKeystoreToken(conn.serverUrl, conn.orgKey);

  const lines = [`Server  ${conn.serverUrl}`, ...(conn.orgKey ? [`Org     ${conn.orgKey}`] : [])];

  if (token === null) {
    note([...lines, '', 'Run "sonar auth login" to restore the token'], '✗ Token missing', {
      borderColor: red,
      titleColor: red,
      contentColor: dim,
    });
  } else {
    note(lines, '✓ Connected', { borderColor: green, titleColor: green, contentColor: dim });
  }
}
