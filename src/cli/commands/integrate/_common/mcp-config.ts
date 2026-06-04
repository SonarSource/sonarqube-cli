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

/** Shared MCP config remove helpers for declarative integration patch resources. */

export const SONARQUBE_MCP_SERVER_ID = 'sonarqube';

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function toMcpSettings(document: unknown): {
  mcpServers: Record<string, unknown>;
  [key: string]: unknown;
} {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { mcpServers: {} };
  }

  const settings = document as { mcpServers?: unknown; [key: string]: unknown };
  return {
    ...settings,
    mcpServers:
      settings.mcpServers &&
      typeof settings.mcpServers === 'object' &&
      !Array.isArray(settings.mcpServers)
        ? { ...(settings.mcpServers as Record<string, unknown>) }
        : {},
  };
}

/**
 * Remove a server entry from JSON MCP config (`mcpServers` object), e.g. Claude/Copilot.
 */
export function removeJsonMcpServer(
  document: unknown,
  serverId: string = SONARQUBE_MCP_SERVER_ID,
): Record<string, unknown> {
  const settings = toMcpSettings(document);
  const { [serverId]: _removed, ...remainingServers } = settings.mcpServers;
  return {
    ...settings,
    mcpServers: remainingServers,
  };
}

/**
 * Remove a server entry from Codex TOML-backed config (`mcp_servers` table keys).
 */
export function removeCodexMcpServer(
  document: Record<string, unknown>,
  serverId: string = SONARQUBE_MCP_SERVER_ID,
): Record<string, unknown> {
  const servers = toRecord(document.mcp_servers);
  const { [serverId]: _removed, ...remainingServers } = servers;
  return {
    ...document,
    mcp_servers: remainingServers,
  };
}
