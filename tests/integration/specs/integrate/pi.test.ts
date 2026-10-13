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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { piIntegration } from '@/commands/integrate/pi/declaration.ts';
import { PI_EXTENSION_MANAGED_MARKER } from '@/commands/integrate/pi/secrets-extension-content.ts';

import { type CliResult, TestHarness } from '../../harness';
import { findInstalledFeature } from './state-helpers';

const SECRETS_EXTENSION_PATH = '.pi/agent/extensions/sonar-secrets.ts';

function findPiFeature(harness: TestHarness, featureId: string) {
  return findInstalledFeature(harness, 'pi', featureId);
}

describe('integrate pi — secrets scanning extension', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'installs the managed secrets extension in ~/.pi/agent/extensions',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');

      const result = await harness.run('integrate pi --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(findPiFeature(harness, 'sonar-secrets-hooks')).toBeDefined();
      const extension = harness.userHome.file(...SECRETS_EXTENSION_PATH.split('/')).asText();
      expect(extension).toContain(PI_EXTENSION_MANAGED_MARKER);
      expect(extension).toContain('pi-pre-tool-use');
      expect(extension).toContain('pi-chat-message');
    },
    { timeout: 30000 },
  );

  it(
    'removes only the secrets extension when the user declines to keep the feature',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness
        .state()
        .withInstalledIntegrationFeature(
          piIntegration,
          'sonar-secrets-hooks',
          'global',
          harness.userHome.path,
        );
      harness.userHome.writeFile(
        SECRETS_EXTENSION_PATH,
        `// ${PI_EXTENSION_MANAGED_MARKER} — do not edit by hand.\n`,
      );
      harness.userHome.writeFile('.pi/agent/extensions/other.ts', 'export default () => {};\n');

      const session = harness.runInteractive('integrate pi');
      await session.decline('secret scanning hooks (currently installed)  Keep?');
      await session.accept('Proceed with removal?');
      await session.decline('Install MCP server?');
      const result: CliResult = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(findPiFeature(harness, 'sonar-secrets-hooks')).toBeUndefined();
      expect(harness.userHome.exists(SECRETS_EXTENSION_PATH)).toBe(false);
      expect(harness.userHome.exists('.pi/agent/extensions/other.ts')).toBe(true);
    },
    { timeout: 30000 },
  );
});

interface PiMcpConfig {
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
  [key: string]: unknown;
}

const MCP_CONFIG_PATH = '.pi/agent/mcp.json';

function readPiMcpConfig(harness: TestHarness): PiMcpConfig {
  return harness.userHome.file(...MCP_CONFIG_PATH.split('/')).asJson() as PiMcpConfig;
}

function writeProjectProperties(harness: TestHarness, serverUrl: string) {
  harness.cwd.writeFile(
    'sonar-project.properties',
    [`sonar.host.url=${serverUrl}`, 'sonar.projectKey=proj'].join('\n'),
  );
}

describe('integrate pi — MCP server configuration', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'writes the sonarqube MCP server entry to ~/.pi/agent/mcp.json',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      writeProjectProperties(harness, server.baseUrl());

      const result = await harness.run('integrate pi --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(readPiMcpConfig(harness).mcpServers?.sonarqube).toMatchObject({
        command: 'sonar',
        args: ['run', 'mcp'],
      });
      expect(findPiFeature(harness, 'mcp-server')).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'preserves the other MCP servers already declared in mcp.json',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      writeProjectProperties(harness, server.baseUrl());
      harness.userHome.writeFile(
        MCP_CONFIG_PATH,
        JSON.stringify({ mcpServers: { other: { command: 'other-mcp' } } }),
      );

      const result = await harness.run('integrate pi --non-interactive');

      expect(result.exitCode).toBe(0);
      const { mcpServers } = readPiMcpConfig(harness);
      expect(mcpServers?.other).toMatchObject({ command: 'other-mcp' });
      expect(mcpServers?.sonarqube).toMatchObject({ command: 'sonar' });
    },
    { timeout: 30000 },
  );

  it(
    'removes only the sonarqube entry when the user declines to keep the feature',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      writeProjectProperties(harness, server.baseUrl());
      for (const featureId of ['sonar-secrets-hooks', 'mcp-server']) {
        harness
          .state()
          .withInstalledIntegrationFeature(
            piIntegration,
            featureId,
            'global',
            harness.userHome.path,
          );
      }
      harness.userHome.writeFile(
        SECRETS_EXTENSION_PATH,
        `// ${PI_EXTENSION_MANAGED_MARKER} — do not edit by hand.\n`,
      );
      harness.userHome.writeFile(
        MCP_CONFIG_PATH,
        JSON.stringify({
          mcpServers: {
            sonarqube: { command: 'sonar', args: ['run', 'mcp'] },
            other: { command: 'x' },
          },
        }),
      );

      const session = harness.runInteractive('integrate pi');
      await session.accept('secret scanning hooks (currently installed)  Keep?');
      await session.decline('MCP server (currently installed)  Keep?');
      await session.accept('Proceed with removal?');
      const result: CliResult = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(findPiFeature(harness, 'mcp-server')).toBeUndefined();
      expect(findPiFeature(harness, 'sonar-secrets-hooks')).toBeDefined();
      const { mcpServers } = readPiMcpConfig(harness);
      expect(mcpServers?.sonarqube).toBeUndefined();
      expect(mcpServers?.other).toMatchObject({ command: 'x' });
    },
    { timeout: 30000 },
  );
});
