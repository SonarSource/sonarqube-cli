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

import { CliError } from '@/core/commands/command-error.ts';
import { getNetworkConfigOrThrow } from '@/core/host/connectivity/network-config.ts';
import { runtimeStatusLine } from '@/core/host/environment/runtime-health-messages.ts';
import {
  checkContainerRuntimeHealth,
  type ContainerRuntimeHealth,
} from '@/core/host/environment/tool-detector.ts';
import {
  readMcpContainerSettings,
  resolveMcpContainerNetworking,
} from '@/core/host/mcp/mcp-network.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import type { Console } from '@/core/ui/console.ts';

import { HostedMcpClient } from '../run/hosted-mcp-client.ts';

export interface McpEndpointStatus {
  connectionMode: 'hosted' | 'container' | null;
  serverUrl: string | null;
  fallbackReason: string | null;
  startupError: string | null;
  containerRuntime: ContainerRuntimeHealth | null;
}

export async function checkMcpEndpoint(
  connection: SonarConnection | null,
): Promise<McpEndpointStatus> {
  const status: McpEndpointStatus = {
    connectionMode: null,
    serverUrl: null,
    fallbackReason: null,
    startupError: null,
    containerRuntime: null,
  };
  try {
    if (!connection) {
      status.startupError = "Not authenticated. Run 'sonar auth login' to authenticate.";
      return status;
    }
    await getNetworkConfigOrThrow();
    const hosted = new HostedMcpClient(connection);
    const availability = await hosted.checkHealth();
    if (availability.available) {
      status.connectionMode = 'hosted';
      status.serverUrl = hosted.url;
      return status;
    }
    status.connectionMode = 'container';
    status.fallbackReason = `hosted MCP ${availability.reason}`;
    status.containerRuntime = await checkContainerRuntimeHealth();
    const detection =
      status.containerRuntime.status === 'not_found'
        ? { runtime: null, viaWsl: false }
        : status.containerRuntime;
    const container = resolveMcpContainerNetworking(
      connection.auth,
      detection,
      await readMcpContainerSettings(),
    );
    status.serverUrl = container.serverUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MCP availability check failed.';
    status.startupError =
      error instanceof CliError && error.remediationHint
        ? `${message} ${error.remediationHint}`
        : message;
  }
  return status;
}

export function renderMcpEndpoint(status: McpEndpointStatus, console: Console): void {
  console.blank();
  console.text('MCP (sonar run mcp --transport auto)');
  if (status.startupError) {
    console.text(`  • Cannot start: ${status.startupError}`);
    return;
  }
  if (status.connectionMode === 'hosted') {
    console.text('  • Transport: HTTP (hosted)');
    console.text(`  • Endpoint: ${status.serverUrl}`);
  } else if (status.connectionMode === 'container') {
    console.text('  • Transport: stdio (local container)');
    console.text(`  • SonarQube server URL: ${status.serverUrl}`);
  }
  if (status.fallbackReason) console.text(`  • Using container because ${status.fallbackReason}.`);
  if (status.containerRuntime)
    console.text(`  • Container runtime: ${runtimeStatusLine(status.containerRuntime)}`);
}
