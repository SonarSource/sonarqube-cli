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

import type { ContainerRuntimeHealth } from './tool-detector.ts';

function runtimeName(health: Extract<ContainerRuntimeHealth, { runtime: string }>): string {
  return `${health.runtime}${health.viaWsl ? ' via WSL' : ''}`;
}

export function runtimeStatusLine(health: ContainerRuntimeHealth): string {
  if (health.status === 'not_found') return 'NOT FOUND';
  if (health.status === 'not_ready' && health.reason === 'timeout') {
    return `NOT RESPONDING (${runtimeName(health)})`;
  }
  return `${health.status.toUpperCase().replace('_', ' ')} (${runtimeName(health)})`;
}

export function runtimeHealthMessage(health: ContainerRuntimeHealth | null): string | null {
  if (health?.status === 'not_found') {
    return 'SonarQube MCP Server needs Docker, Podman, or nerdctl. Install and start one to use the MCP server.';
  }
  if (health?.status !== 'not_ready') return null;
  return health.reason === 'timeout'
    ? `${runtimeName(health)} is not responding to the runtime check. The MCP launcher may wait for it.`
    : `SonarQube MCP Server cannot start because ${runtimeName(health)} is not ready. Start or repair it.`;
}
