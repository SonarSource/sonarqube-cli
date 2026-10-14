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

import { describe, expect, it } from 'bun:test';

import {
  removeMcpServer,
  upsertMcpServer,
} from '@/commands/integrate/_common/features/mcp-server-feature.ts';
import {
  devinIntegration,
  resolveDevinAgentsMdPath,
  resolveDevinConfigPath,
  resolveDevinMcpConfigPath,
} from '@/commands/integrate/devin/declaration.ts';
import { type IntegrationContext, isFeatureContainer } from '@/core/framework/features';

import { FakeConsole } from '../../../../_common/fake-console.ts';

function fakeContext(targetRoot: string): IntegrationContext {
  return {
    targetRoot,
    scope: 'global',
    attrs: {},
    state: {} as never,
    executionMode: 'install',
    console: new FakeConsole(),
    resolvedDependencies: new Map(),
  };
}

describe('devinIntegration features', () => {
  it('declares the vortex container and the mcp-server feature', () => {
    expect(devinIntegration.features.map((feature) => feature.id)).toEqual([
      'vortex',
      'mcp-server',
    ]);
  });

  it('puts the Vortex analysis hook and instructions in the vortex container', () => {
    const vortex = devinIntegration.features.find((feature) => feature.id === 'vortex');

    expect(vortex && isFeatureContainer(vortex)).toBe(true);
    const subfeatureIds =
      vortex && isFeatureContainer(vortex) ? vortex.subfeatures.map((s) => s.id) : [];
    expect(subfeatureIds).toEqual(['sonar-sqaa-hook', 'sqaa-instructions']);
  });
});

describe('devinIntegration config paths', () => {
  it('targets config.json and AGENTS.md in the Devin config dir', () => {
    expect(resolveDevinConfigPath(fakeContext('/home/jonathan'), {}, 'linux')).toBe(
      join('/home/jonathan', '.config', 'devin', 'config.json'),
    );
    expect(resolveDevinAgentsMdPath(fakeContext('/home/jonathan'), {}, 'darwin')).toBe(
      join('/home/jonathan', '.config', 'devin', 'AGENTS.md'),
    );
  });

  it('targets %APPDATA%\\devin on Windows', () => {
    const env = { APPDATA: '/roaming' };

    expect(resolveDevinConfigPath(fakeContext('/home/jonathan'), env, 'win32')).toBe(
      join('/roaming', 'devin', 'config.json'),
    );
    expect(resolveDevinAgentsMdPath(fakeContext('/home/jonathan'), env, 'win32')).toBe(
      join('/roaming', 'devin', 'AGENTS.md'),
    );
  });
});

describe('devinIntegration MCP server feature', () => {
  it('targets mcp_config.json in ~/.config/devin on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(resolveDevinMcpConfigPath(fakeContext('/home/jonathan'), {}, platform)).toBe(
        join('/home/jonathan', '.config', 'devin', 'mcp_config.json'),
      );
    }
  });

  it('targets mcp_config.json in %APPDATA%\\devin on Windows', () => {
    expect(
      resolveDevinMcpConfigPath(fakeContext('/home/jonathan'), { APPDATA: '/roaming' }, 'win32'),
    ).toBe(join('/roaming', 'devin', 'mcp_config.json'));
  });
});

describe('Devin MCP config patching', () => {
  const sonarqube = { command: 'sonar', args: ['run', 'mcp'] };

  it('removes only sonarqube on uninstall', () => {
    const installed = upsertMcpServer({ mcpServers: { other: { command: 'x' } } }, sonarqube);

    expect(removeMcpServer(installed)).toEqual({ mcpServers: { other: { command: 'x' } } });
  });
});
