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

import type { ResultAsync } from '@/core/result.ts';
import { ComponentsClient } from '@/core/server/components.ts';
import type { HttpClientError } from '@/core/server/errors.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';

export class BadgesClient {
  readonly components: ComponentsClient;

  constructor(private readonly client: SonarHttpClient) {
    this.components = new ComponentsClient(client);
  }

  getToken(project: string): ResultAsync<unknown, HttpClientError> {
    if (this.client.isCloud) {
      return this.client
        .get<{ badgeToken?: unknown } | undefined>('/api/navigation/component', {
          component: project,
        })
        .map((response) => response?.badgeToken);
    }
    return this.client
      .get<{ token?: unknown } | undefined>('/api/project_badges/token', { project })
      .map((response) => response?.token);
  }
}
