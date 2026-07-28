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

import { describe, expect, it } from 'bun:test';

import type { ContainerIntegrationContext } from '@/core/framework/features';
import { getDefaultState } from '@/core/state/state.ts';

import {
  removeAgentHooks,
  SONAR_SECRETS_MARKER,
  upsertAgentHooks,
} from '../../../../../src/commands/integrate/_common/hooks.ts';
import {
  removeCodexMcpServer,
  removeJsonMcpServer,
  upsertJsonMcpServer,
} from '../../../../../src/commands/integrate/_common/mcp-config.ts';
import { removeCopilotHookConfig } from '../../../../../src/commands/integrate/copilot/hooks.ts';
import {
  normalizePreCommitConfig,
  removeSonarHooksFromPreCommitConfig,
  upsertSonarHook,
} from '../../../../../src/commands/integrate/git/tools/pre-commit';

function context(): ContainerIntegrationContext {
  return {
    state: getDefaultState('test'),
    targetRoot: '/tmp',
    scope: 'global',
    executionMode: 'install',
    resolvedDependencies: new Map(),
    activeSubfeatures: [],
  };
}

describe('integration remove helpers', () => {
  it('removeAgentHooks strips entries managed by marker', () => {
    const patched = upsertAgentHooks(
      {
        hooks: {
          PostToolUse: [
            { matcher: 'x', hooks: [{ type: 'command', command: 'other', timeout: 60 }] },
          ],
        },
      },
      [
        {
          eventType: 'PostToolUse',
          marker: 'sonar-sqaa',
          hookConfig: {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'sonar-sqaa/script.sh', timeout: 60 }],
          },
        },
      ],
    );

    const removed = removeAgentHooks(patched, ['sonar-sqaa']);

    expect(removed.hooks?.PostToolUse).toHaveLength(1);
    expect(removed.hooks?.PostToolUse?.[0]?.hooks[0]?.command).toBe('other');
  });

  it('upsertJsonMcpServer inserts sonarqube entry into an empty document', () => {
    const result = upsertJsonMcpServer({}, { command: 'sonar', args: ['run', 'mcp'] });

    expect(result.mcpServers).toEqual({ sonarqube: { command: 'sonar', args: ['run', 'mcp'] } });
  });

  it('upsertJsonMcpServer preserves existing mcpServers entries', () => {
    const result = upsertJsonMcpServer(
      { mcpServers: { other: { command: 'x' } } },
      { command: 'sonar', args: ['run', 'mcp'] },
    );

    expect(result.mcpServers).toEqual({
      other: { command: 'x' },
      sonarqube: { command: 'sonar', args: ['run', 'mcp'] },
    });
  });

  it('upsertJsonMcpServer overwrites an existing sonarqube entry', () => {
    const result = upsertJsonMcpServer(
      { mcpServers: { sonarqube: { command: 'old' } } },
      { command: 'sonar', args: ['run', 'mcp'] },
    );

    expect(result.mcpServers).toEqual({ sonarqube: { command: 'sonar', args: ['run', 'mcp'] } });
  });

  it('upsertJsonMcpServer preserves other top-level keys', () => {
    const result = upsertJsonMcpServer({ inputs: [{ type: 'promptString', id: 'token' }] }, {});

    expect(result.inputs).toEqual([{ type: 'promptString', id: 'token' }]);
  });

  it('upsertJsonMcpServer handles a non-object document gracefully', () => {
    expect(upsertJsonMcpServer(null, { command: 'sonar' }).mcpServers).toEqual({
      sonarqube: { command: 'sonar' },
    });
    expect(upsertJsonMcpServer(['unexpected'], { command: 'sonar' }).mcpServers).toEqual({
      sonarqube: { command: 'sonar' },
    });
  });

  it('upsertJsonMcpServer uses a custom serverId when provided', () => {
    const result = upsertJsonMcpServer({}, { command: 'sonar' }, 'my-server');

    expect(result.mcpServers).toEqual({ 'my-server': { command: 'sonar' } });
    expect(result.mcpServers).not.toHaveProperty('sonarqube');
  });

  it('removeJsonMcpServer drops sonarqube server only', () => {
    const result = removeJsonMcpServer({
      mcpServers: { sonarqube: { command: 'sonar' }, other: { command: 'x' } },
    });

    expect(result.mcpServers).toEqual({ other: { command: 'x' } });
  });

  it('removeCodexMcpServer drops sonarqube from mcp_servers', () => {
    const result = removeCodexMcpServer({
      mcp_servers: { sonarqube: { command: 'sonar' }, other: {} },
    });

    expect(result.mcp_servers).toEqual({ other: {} });
  });

  it('removeCopilotHookConfig strips sonar-secrets preToolUse entry', () => {
    const result = removeCopilotHookConfig({
      version: 1,
      hooks: {
        preToolUse: [
          { type: 'command', bash: 'sonar-secrets/build-scripts/pretool-secrets.sh' },
          { type: 'command', bash: '/usr/bin/other' },
        ],
      },
    });

    expect(result.hooks?.preToolUse).toEqual([{ type: 'command', bash: '/usr/bin/other' }]);
  });

  it('removeSonarHooksFromPreCommitConfig removes local sonar hook', () => {
    const config = normalizePreCommitConfig({ repos: [] });
    upsertSonarHook(config, 'pre-commit', context());

    const removed = removeSonarHooksFromPreCommitConfig(config);

    expect(removed.repos).toEqual([]);
  });

  it('removeAgentHooks is a no-op for unrelated markers', () => {
    const doc = upsertAgentHooks({}, [
      {
        eventType: 'PostToolUse',
        marker: SONAR_SECRETS_MARKER,
        hookConfig: {
          matcher: 'x',
          hooks: [{ type: 'command', command: `${SONAR_SECRETS_MARKER}/hook.sh`, timeout: 60 }],
        },
      },
    ]);

    const removed = removeAgentHooks(doc, ['sonar-sqaa']);

    expect(removed.hooks?.PostToolUse).toHaveLength(1);
  });
});
