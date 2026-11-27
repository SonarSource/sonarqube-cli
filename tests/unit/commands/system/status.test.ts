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

import { expect, it } from 'bun:test';

import { renderMcpEndpoint } from '@/commands/system/status.ts';
import type { McpEndpointStatus } from '@/core/host/mcp/mcp-endpoint.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const container: McpEndpointStatus = {
  transportSelection: { mode: 'auto', source: 'default' },
  connectionMode: 'container',
  serverUrl: 'http://sonarqube:9000',
  fallbackReason: 'hosted MCP health check returned HTTP 404',
  startupError: null,
  containerRuntime: { status: 'ready', runtime: 'docker', viaWsl: false },
};

it.each<{
  name: string;
  status: McpEndpointStatus;
  lines: string[];
}>([
  {
    name: 'hosted endpoint',
    status: {
      ...container,
      connectionMode: 'hosted',
      serverUrl: 'https://example.com/mcp',
      fallbackReason: null,
      containerRuntime: null,
    },
    lines: ['  • Transport: HTTP (hosted)', '  • Endpoint: https://example.com/mcp'],
  },
  {
    name: 'container fallback',
    status: container,
    lines: [
      '  • Transport: stdio (local container)',
      '  • SonarQube server URL: http://sonarqube:9000',
      '  • Using container because hosted MCP health check returned HTTP 404.',
      '  • Container runtime: READY (docker)',
    ],
  },
  {
    name: 'configured stdio',
    status: {
      ...container,
      transportSelection: { mode: 'stdio', source: 'config' },
      fallbackReason: null,
    },
    lines: [
      '  • Transport: stdio (local container), from mcp.transport=stdio',
      '  • SonarQube server URL: http://sonarqube:9000',
      '  • Container runtime: READY (docker)',
    ],
  },
  {
    name: 'startup error',
    status: { ...container, startupError: 'Invalid token.' },
    lines: ['  • Cannot start: Invalid token.'],
  },
])('renders MCP $name', ({ status, lines }) => {
  const console = new FakeConsole();
  renderMcpEndpoint(status, console);
  expect(
    console.calls.filter((call) => call.method === 'text').map((call) => call.args[0]),
  ).toEqual(['MCP (sonar run mcp)', ...lines]);
});
