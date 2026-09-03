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

// SonarQube System API wrapper — instance status and clean-code policy mode.

import type { SonarHttpClient } from './http-client.ts';

export class SystemClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  async getServerMode(): Promise<'mqr' | 'standard'> {
    if (this.client.isCloud) return 'mqr';
    const result = await this.client.getOrNotFound<{ mode: string }>(
      '/api/v2/clean-code-policy/mode',
    );
    return result?.mode === 'MQR' ? 'mqr' : 'standard';
  }
}
