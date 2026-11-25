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

import { expect, it, spyOn } from 'bun:test';

import { warnIfMcpRuntimeUnavailable } from '@/commands/integrate/_common/mcp-runtime-warning.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import * as mcpEndpoint from '@/core/host/mcp/mcp-endpoint.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

it('warns only when the shared MCP check reports a startup or runtime problem', async () => {
  const connection = {
    auth: new ResolvedAuth({
      serverUrl: 'http://localhost:9000',
      token: 'test-token',
      connectionType: 'on-premise',
      source: 'state',
    }),
    httpClient: new SonarHttpClient('http://localhost:9000', 'test-token'),
  };
  const state = getDefaultState('test');
  state.integrations.installed.push({
    id: 'test',
    integrationId: 'claude-code',
    installedByCliVersion: 'test',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedByCliVersion: 'test',
    updatedAt: '2026-01-01T00:00:00.000Z',
    features: [
      {
        featureId: 'mcp-server',
        scope: 'project',
        targetRoot: '/repo',
        installedByCliVersion: 'test',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: 'test',
        updatedAt: '2026-01-01T00:00:00.000Z',
        dependencies: [],
        resources: [],
        operations: [],
      },
    ],
  });
  const stateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(state);
  const console = new FakeConsole();
  const status: mcpEndpoint.McpEndpointStatus = {
    transportSelection: { mode: 'auto', source: 'default' },
    connectionMode: 'hosted',
    serverUrl: 'http://localhost:9000/mcp',
    fallbackReason: null,
    startupError: null,
    containerRuntime: null,
  };
  const endpointSpy = spyOn(mcpEndpoint, 'checkMcpEndpoint').mockResolvedValue(status);

  try {
    await warnIfMcpRuntimeUnavailable(console, 'claude-code', '/repo', connection);
    expect(console.calls).toEqual([]);
    expect(endpointSpy).toHaveBeenCalledWith(connection);

    status.connectionMode = 'container';
    status.containerRuntime = {
      status: 'not_ready',
      runtime: 'docker',
      viaWsl: false,
      reason: 'timeout',
    };
    await warnIfMcpRuntimeUnavailable(console, 'claude-code', '/repo', connection);

    expect(console.calls).toEqual([
      {
        method: 'warn',
        args: ['docker is not responding to the runtime check. The MCP launcher may wait for it.'],
      },
    ]);

    status.startupError = "Hosted MCP health check returned HTTP 401. Run 'sonar auth login'.";
    console.calls.length = 0;
    await warnIfMcpRuntimeUnavailable(console, 'claude-code', '/repo', connection);
    expect(console.calls).toEqual([
      {
        method: 'warn',
        args: ["Hosted MCP health check returned HTTP 401. Run 'sonar auth login'."],
      },
    ]);
  } finally {
    endpointSpy.mockRestore();
    stateSpy.mockRestore();
  }
});
