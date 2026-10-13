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

import { supportedIntegrations } from '@/commands/integrate';
import {
  PI_INTEGRATION_ID,
  piIntegration,
  resolvePiMcpConfigPath,
  resolvePiSecretsExtensionPath,
} from '@/commands/integrate/pi/declaration.ts';
import {
  PI_EXTENSION_MANAGED_MARKER,
  PI_SECRETS_EXTENSION_CONTENT,
} from '@/commands/integrate/pi/secrets-extension-content.ts';
import type { IntegrationContext } from '@/core/framework/features';

import { FakeConsole } from '../../../../_common/fake-console.ts';

function fakeContext(scope: IntegrationContext['scope'], targetRoot: string): IntegrationContext {
  return {
    targetRoot,
    scope,
    attrs: {},
    state: {} as never,
    executionMode: 'install',
    console: new FakeConsole(),
    resolvedDependencies: new Map(),
  };
}

describe('resolvePiSecretsExtensionPath', () => {
  it('writes to ~/.pi/agent/extensions for the global scope', () => {
    expect(resolvePiSecretsExtensionPath(fakeContext('global', '/home/jonathan'))).toBe(
      join('/home/jonathan', '.pi', 'agent', 'extensions', 'sonar-secrets.ts'),
    );
  });

  it('writes to <project>/.pi/extensions for the project scope', () => {
    expect(resolvePiSecretsExtensionPath(fakeContext('project', '/project/root'))).toBe(
      join('/project/root', '.pi', 'extensions', 'sonar-secrets.ts'),
    );
  });
});

describe('resolvePiMcpConfigPath', () => {
  it('writes to ~/.pi/agent/mcp.json for the global scope', () => {
    expect(resolvePiMcpConfigPath(fakeContext('global', '/home/jonathan'))).toBe(
      join('/home/jonathan', '.pi', 'agent', 'mcp.json'),
    );
  });

  it('writes to <project>/.pi/mcp.json for the project scope', () => {
    expect(resolvePiMcpConfigPath(fakeContext('project', '/project/root'))).toBe(
      join('/project/root', '.pi', 'mcp.json'),
    );
  });
});

describe('piIntegration', () => {
  it('is declared as the pi integration, displayed as Pi', () => {
    expect(piIntegration.id).toBe('pi');
    expect(PI_INTEGRATION_ID).toBe('pi');
    expect(piIntegration.displayName).toBe('Pi');
  });

  it('declares the secret-scanning-hooks feature backed by the sonar-secrets binary', () => {
    const feature = piIntegration.features.find(
      (candidate) => candidate.id === 'sonar-secrets-hooks',
    );

    expect(feature?.dependencies).toHaveLength(1);
    expect(feature?.resources).toHaveLength(1);
  });

  it('declares the mcp-server feature with a single MCP configuration resource', () => {
    const feature = piIntegration.features.find((candidate) => candidate.id === 'mcp-server');

    expect(feature?.resources).toHaveLength(1);
  });

  it('is registered with the supported integrations', () => {
    expect(supportedIntegrations.get(PI_INTEGRATION_ID)).toBe(piIntegration);
  });
});

describe('PI_SECRETS_EXTENSION_CONTENT', () => {
  it('wires tool_call to the pi-pre-tool-use hook subcommand', () => {
    expect(PI_SECRETS_EXTENSION_CONTENT).toContain("'tool_call'");
    expect(PI_SECRETS_EXTENSION_CONTENT).toContain('pi-pre-tool-use');
  });

  it('wires message_end to the pi-chat-message hook subcommand', () => {
    expect(PI_SECRETS_EXTENSION_CONTENT).toContain("'message_end'");
    expect(PI_SECRETS_EXTENSION_CONTENT).toContain('pi-chat-message');
  });

  it('carries the managed marker so the file can be removed safely', () => {
    expect(PI_SECRETS_EXTENSION_CONTENT).toContain(PI_EXTENSION_MANAGED_MARKER);
  });

  it('is valid, parseable TypeScript', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    expect(() => transpiler.transformSync(PI_SECRETS_EXTENSION_CONTENT)).not.toThrow();
  });
});
