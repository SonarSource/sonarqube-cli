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

import type {
  FeatureDeclaration,
  IntegrationContext,
  ResourceDeclaration,
} from '@/core/framework/features';
import { jsonPatch, tomlPatch } from '@/core/framework/features';
import { getMcpConfig, getMcpConfigFilePath } from '@/core/host/mcp/mcp-helper.ts';

import type { AgentIntegrateSubcommand } from '../agent-integrate-prelude.ts';
import { getOptionalStringAttr } from '../attrs.ts';
import { MCP_SERVER_FEATURE_BENEFIT, MCP_SERVER_FEATURE_PREVIEW } from '../feature-constants.ts';
import type { IntegrateAgentOptions } from '../types.ts';

export const MCP_SERVER_FEATURE_ID = 'mcp-server';

export type McpConfigFormat = 'json' | 'toml';

export interface McpServerFeatureConfig {
  agent: AgentIntegrateSubcommand;
  format?: McpConfigFormat;
  alwaysGlobal?: boolean;
}

export function createMcpServerFeature<TOptions extends IntegrateAgentOptions>(
  config: McpServerFeatureConfig,
): FeatureDeclaration<TOptions> {
  return {
    id: MCP_SERVER_FEATURE_ID,
    displayName: 'MCP server',
    benefitDescription: MCP_SERVER_FEATURE_BENEFIT,
    previewDescription: MCP_SERVER_FEATURE_PREVIEW,
    resources: [createMcpConfigResource(config)],
  };
}

const SONARQUBE_MCP_SERVER_ID = 'sonarqube';

const SERVERS_KEY: Record<McpConfigFormat, string> = {
  json: 'mcpServers',
  toml: 'mcp_servers',
};

function createMcpConfigResource({
  agent,
  format = 'json',
  alwaysGlobal = false,
}: McpServerFeatureConfig): ResourceDeclaration {
  const options = {
    id: `${agent}-mcp-config`,
    displayName: 'MCP configuration',
    targetPath: (context: IntegrationContext) =>
      getMcpConfigFilePath(agent, alwaysGlobal || context.scope === 'global', context.targetRoot),
    defaultValue: {},
    patch: (document: Record<string, unknown>, context: IntegrationContext) =>
      upsertMcpServer(document, desiredMcpServerConfig(context, alwaysGlobal), format),
    removePatch: (document: Record<string, unknown>) => removeMcpServer(document, format),
  };

  return format === 'toml' ? tomlPatch(options) : jsonPatch(options);
}

function desiredMcpServerConfig(context: IntegrationContext, alwaysGlobal: boolean) {
  return getMcpConfig(
    alwaysGlobal || context.scope === 'global'
      ? { withFsMount: false }
      : {
          withFsMount: true,
          projectRoot: context.targetRoot,
          projectKey: getOptionalStringAttr(context, 'projectKey'),
        },
  );
}

export function upsertMcpServer(
  document: unknown,
  serverConfig: object,
  format: McpConfigFormat = 'json',
): Record<string, unknown> {
  const serversKey = SERVERS_KEY[format];
  const { settings, servers } = toMcpDocument(document, serversKey);
  return {
    ...settings,
    [serversKey]: {
      ...servers,
      [SONARQUBE_MCP_SERVER_ID]: serverConfig,
    },
  };
}

export function removeMcpServer(
  document: unknown,
  format: McpConfigFormat = 'json',
): Record<string, unknown> {
  const serversKey = SERVERS_KEY[format];
  const { settings, servers } = toMcpDocument(document, serversKey);
  const { [SONARQUBE_MCP_SERVER_ID]: _removed, ...remainingServers } = servers;
  return {
    ...settings,
    [serversKey]: remainingServers,
  };
}

function toMcpDocument(
  document: unknown,
  serversKey: string,
): { settings: Record<string, unknown>; servers: Record<string, unknown> } {
  const settings = toRecord(document);
  return { settings, servers: toRecord(settings[serversKey]) };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}
