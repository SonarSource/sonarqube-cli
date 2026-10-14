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
import { InvalidOptionError } from '@/core/commands/command-error.ts';
import * as toolDetector from '@/core/host/environment/tool-detector.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

it('warns that a timed-out runtime may delay the MCP launcher', async () => {
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
  const healthSpy = spyOn(toolDetector, 'checkContainerRuntimeHealth').mockResolvedValue({
    status: 'not_ready',
    runtime: 'docker',
    viaWsl: false,
    reason: 'timeout',
  });
  const console = new FakeConsole();

  try {
    await warnIfMcpRuntimeUnavailable(console, 'claude-code', '/repo');

    expect(console.calls).toEqual([
      {
        method: 'warn',
        args: ['docker is not responding to the runtime check. The MCP launcher may wait for it.'],
      },
    ]);

    healthSpy.mockRejectedValue(
      new InvalidOptionError('SONARQUBE_CLI_MCP_WSL must be auto, always, or never.'),
    );
    console.calls.length = 0;
    await warnIfMcpRuntimeUnavailable(console, 'claude-code', '/repo');
    expect(console.calls).toEqual([
      {
        method: 'warn',
        args: ['SONARQUBE_CLI_MCP_WSL must be auto, always, or never.'],
      },
    ]);
  } finally {
    stateSpy.mockRestore();
    healthSpy.mockRestore();
  }
});
