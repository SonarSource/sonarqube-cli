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

import { ComponentsClient } from '@/core/server/components.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { ProjectBindingsClient } from '@/core/server/project-bindings.ts';
import { UsersClient } from '@/core/server/users.ts';

/**
 * The SonarQube Server APIs this command drives, built from one transport client so
 * they share it for the whole run. Exposed as fields rather than re-declared as
 * forwarding methods.
 */
export class OnboardCiSqsClient {
  readonly bindings: ProjectBindingsClient;
  readonly components: ComponentsClient;
  readonly users: UsersClient;

  constructor(client: SonarHttpClient) {
    this.bindings = new ProjectBindingsClient(client);
    this.components = new ComponentsClient(client);
    this.users = new UsersClient(client);
  }
}
