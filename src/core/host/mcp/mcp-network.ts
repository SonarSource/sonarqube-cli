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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { getBooleanConfigValue, getConfigValue } from '@/core/config/config-repository.ts';

import type { ContainerRuntimeDetection } from '../environment/tool-detector.ts';

export interface McpContainerSettings {
  network?: string;
  addHost?: string;
  serverUrl?: string;
  /** Opt-in: let a loopback SonarQube URL be routed to the MCP container automatically. */
  autoNetwork?: boolean;
}

export interface ResolvedMcpContainerNetworking {
  network?: string;
  addHost?: string;
  serverUrl: string;
}

export async function readMcpContainerSettings(): Promise<McpContainerSettings> {
  const [network, addHost, serverUrl] = await Promise.all([
    getConfigValue('mcp.container.network'),
    getConfigValue('mcp.container.addHost'),
    getConfigValue('mcp.container.serverUrl'),
  ]);
  const autoNetwork = getBooleanConfigValue('mcp.container.autoNetwork', false);
  return { network, addHost, serverUrl, autoNetwork };
}

export function isLoopbackServerUrl(serverUrl: string): boolean {
  try {
    const hostname = new URL(serverUrl).hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
      hostname === '0.0.0.0' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

function validateContainerServerUrl(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new InvalidOptionError('mcp.container.serverUrl must be an HTTP or HTTPS URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new InvalidOptionError(
      'mcp.container.serverUrl must be an HTTP or HTTPS URL without credentials.',
    );
  }
  return serverUrl;
}

export function resolveMcpContainerNetworking(
  auth: ResolvedAuth,
  detection: ContainerRuntimeDetection,
  settings: McpContainerSettings,
  platform: NodeJS.Platform = process.platform,
): ResolvedMcpContainerNetworking {
  if (auth.connectionType === 'cloud') {
    return { serverUrl: auth.serverUrl };
  }

  if (settings.network || settings.addHost || settings.serverUrl) {
    return {
      serverUrl: settings.serverUrl
        ? validateContainerServerUrl(settings.serverUrl)
        : auth.serverUrl,
      network: settings.network,
      addHost: settings.addHost,
    };
  }

  if (!settings.autoNetwork || !isLoopbackServerUrl(auth.serverUrl) || !detection.runtime) {
    return { serverUrl: auth.serverUrl };
  }

  if (platform === 'linux' && !detection.viaWsl) {
    return { serverUrl: auth.serverUrl, network: 'host' };
  }

  let hostAlias: string | undefined;
  if (detection.runtime === 'docker') {
    hostAlias = 'host.docker.internal';
  } else if (detection.runtime === 'podman') {
    hostAlias = 'host.containers.internal';
  }
  if (!hostAlias) {
    return { serverUrl: auth.serverUrl };
  }
  const containerUrl = new URL(auth.serverUrl);
  containerUrl.hostname = hostAlias;
  return { serverUrl: containerUrl.toString() };
}

export function mcpLoopbackAdvice(
  auth: ResolvedAuth,
  settings: McpContainerSettings,
): string | undefined {
  if (auth.connectionType === 'cloud' || !isLoopbackServerUrl(auth.serverUrl)) {
    return undefined;
  }
  if (settings.serverUrl && !isLoopbackServerUrl(settings.serverUrl)) {
    return undefined;
  }
  if (settings.network === 'host' && !settings.serverUrl) {
    return 'The MCP container uses host networking for the loopback SonarQube URL. If tools are unavailable, verify that the server is reachable from the container runtime.';
  }
  if (settings.network || settings.addHost || settings.serverUrl) {
    return 'The MCP container still uses a loopback SonarQube URL. Set mcp.container.serverUrl to an address reachable from the container, and verify its network or host mapping.';
  }
  if (settings.autoNetwork) {
    return 'The MCP container needs a route to the loopback SonarQube URL. Native Linux uses host networking; Docker and Podman elsewhere use host aliases. For Nerdctl outside native Linux, or if tools are unavailable, set mcp.container.serverUrl and mcp.container.network to reachable values.';
  }
  return 'The MCP container cannot reach the loopback SonarQube URL by default. Set mcp.container.autoNetwork to true to route it automatically (native Linux uses host networking; Docker and Podman elsewhere use host aliases), or set mcp.container.serverUrl and mcp.container.network yourself.';
}
