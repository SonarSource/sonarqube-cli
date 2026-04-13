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

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import { SonarQubeClient } from '../../../sonarqube/client';
import { print } from '../../../ui';

export interface PingOptions {
  json: boolean;
}

export async function pingCommand(options: PingOptions, auth: ResolvedAuth): Promise<void> {
  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  const status = await client.getSystemStatus();

  if (options.json) {
    print(
      JSON.stringify({ serverUrl: auth.serverUrl, status: status.status, version: status.version }),
    );
  } else {
    print(`Server:  ${auth.serverUrl}`);
    print(`Status:  ${status.status}`);
    print(`Version: ${status.version}`);
  }
}
