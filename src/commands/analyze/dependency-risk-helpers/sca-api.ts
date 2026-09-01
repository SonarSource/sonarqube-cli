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

// The two server calls a dependency-risks scan makes, as one port the orchestrator depends on.

import { ComponentsClient } from '@/core/server/components.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { ScaClient } from '@/core/server/sca.ts';
import type { SettingsValue } from '@/core/server/settings-value.ts';

export interface ScaScanApi {
  checkScaEnabled(connectionType: 'cloud' | 'on-premise', orgKey?: string): Promise<boolean>;
  getProjectSettings(projectKey: string): Promise<SettingsValue[]>;
}

export function createScaScanApi(serverUrl: string, token: string): ScaScanApi {
  const http = new SonarHttpClient(serverUrl, token);
  const sca = new ScaClient(http);
  const components = new ComponentsClient(http);
  return {
    checkScaEnabled: (connectionType, orgKey) => sca.checkScaEnabled(connectionType, orgKey),
    getProjectSettings: (projectKey) => components.getProjectSettings(projectKey),
  };
}
