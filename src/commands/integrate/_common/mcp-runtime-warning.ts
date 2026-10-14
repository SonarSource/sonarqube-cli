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

import { checkContainerRuntimeHealth } from '@/core/host/environment/tool-detector.ts';
import { loadState } from '@/core/state/state-repository.ts';
import type { Console } from '@/core/ui/console.ts';

export async function warnIfMcpRuntimeUnavailable(
  console: Console,
  integrationId: string,
  targetRoot: string,
): Promise<void> {
  const hasMcp = loadState().integrations.installed.some(
    (integration) =>
      integration.integrationId === integrationId &&
      integration.features.some(
        (feature) => feature.featureId === 'mcp-server' && feature.targetRoot === targetRoot,
      ),
  );
  if (!hasMcp) return;
  const health = await checkContainerRuntimeHealth();
  if (health.status === 'missing') {
    console.warn(
      'MCP needs Docker, Podman, or nerdctl. Install and start one to use the MCP server.',
    );
  } else if (health.status === 'unavailable') {
    console.warn(
      health.reason === 'timeout'
        ? `${health.runtime} is not responding to the runtime check. The MCP launcher may wait for it.`
        : `MCP cannot start because ${health.runtime} is unavailable. Start or repair it.`,
    );
  }
}
