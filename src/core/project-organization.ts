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

import { ProjectOrganizationError } from '@/core/errors.ts';
import { ComponentsClient } from '@/core/server/components.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { AccessDeniedError } from '@/core/server/errors.ts';
import { HTTP_STATUS_FORBIDDEN } from '@/core/server/http-constants.ts';

export async function assertProjectInOrganization(
  connection: SonarConnection,
  projectKey: string,
): Promise<void> {
  const organization = connection.auth.orgKey;
  if (!connection.httpClient.isCloud || !organization) return;

  const lookup = await new ComponentsClient(connection.httpClient).getComponent(projectKey);
  if (
    lookup.isErr() &&
    !(lookup.error instanceof AccessDeniedError && lookup.error.status === HTTP_STATUS_FORBIDDEN)
  ) {
    throw lookup.error;
  }
  const actualOrganization = lookup.isOk() ? lookup.value?.organization : undefined;
  if (actualOrganization === organization) return;

  throw new ProjectOrganizationError(projectKey, organization, actualOrganization);
}
