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

import { join } from 'node:path';

import type { IntegrationContext, IntegrationDeclaration } from '@/core/framework/features';
import { resolveDevinConfigDir } from '@/core/host/environment/devin-config-dir.ts';

import { createMcpServerFeature } from '../_common/features/mcp-server-feature.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';

export const DEVIN_INTEGRATION_ID = 'devin';
const DEVIN_DISPLAY_NAME = 'Devin';

export type DevinIntegrationOptions = IntegrateAgentOptions;

const DEVIN_MCP_CONFIG_FILE = 'mcp_config.json';

export function resolveDevinMcpConfigPath(
  context: IntegrationContext,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(resolveDevinConfigDir(context.targetRoot, env, platform), DEVIN_MCP_CONFIG_FILE);
}

export const devinIntegration: IntegrationDeclaration<DevinIntegrationOptions> = {
  id: DEVIN_INTEGRATION_ID,
  displayName: DEVIN_DISPLAY_NAME,
  features: [
    createMcpServerFeature<DevinIntegrationOptions>({
      resolveConfigPath: resolveDevinMcpConfigPath,
      alwaysGlobal: true,
    }),
  ],
};
