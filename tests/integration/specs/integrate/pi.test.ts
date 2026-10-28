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

import { CONTEXT_AUGMENTATION_FEATURE_ID } from '@/commands/integrate/_common/features/context-augmentation-feature.ts';
import { SQAA_HOOK_FEATURE_ID } from '@/commands/integrate/_common/features/sqaa-instructions-feature.ts';
import { VORTEX_FEATURE_ID } from '@/commands/integrate/_common/vortex.ts';
import { PI_CAG_EXTENSION_CONTENT } from '@/commands/integrate/pi/cag-extension-content.ts';
import { piIntegration } from '@/commands/integrate/pi/declaration.ts';
import { PI_EXTENSION_MANAGED_MARKER } from '@/commands/integrate/pi/secrets-extension-content.ts';
import { PI_SQAA_EXTENSION_CONTENT } from '@/commands/integrate/pi/sqaa-extension-content.ts';

import { type CliResult, TestHarness } from '../../harness';
import { chooseCustomize } from './integrate-test-helpers';
import { findInstalledFeature, findInstalledSubfeature } from './state-helpers';

const SECRETS_EXTENSION_PATH = '.pi/agent/extensions/sonar-secrets.ts';
const SQAA_EXTENSION_PATH = '.pi/agent/extensions/sonar-sqaa.ts';
const CAG_EXTENSION_PATH = '.pi/agent/extensions/sonar-cag.ts';
const TEST_ORG = 'my-org';
const TEST_PROJECT = 'my-project';

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
      await chooseCustomize(session);
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

describe('integrate pi — Vortex feature', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled().withContextAugmentationBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'writes the SQAA and Context extensions when Vortex is entitled',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
        .withVortexEntitlement(TEST_ORG, 'test-uuid-1234')
        .withProject(TEST_PROJECT)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

      const result = await harness.run('integrate pi --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const extension = harness.userHome.file(...SQAA_EXTENSION_PATH.split('/'));
      expect(extension.exists()).toBe(true);
      expect(extension.asText()).toBe(PI_SQAA_EXTENSION_CONTENT);
      expect(
        findInstalledSubfeature(harness, 'pi', VORTEX_FEATURE_ID, SQAA_HOOK_FEATURE_ID),
      ).toBeDefined();
      expect(harness.userHome.file(...CAG_EXTENSION_PATH.split('/')).asText()).toBe(
        PI_CAG_EXTENSION_CONTENT,
      );
      expect(
        findInstalledSubfeature(harness, 'pi', VORTEX_FEATURE_ID, CONTEXT_AUGMENTATION_FEATURE_ID),
      ).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'does not install Vortex when the organization is not entitled',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
        .withProject(TEST_PROJECT)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

      const result = await harness.run('integrate pi --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(harness.userHome.exists(SQAA_EXTENSION_PATH)).toBe(false);
      expect(harness.userHome.exists(CAG_EXTENSION_PATH)).toBe(false);
      expect(findPiFeature(harness, VORTEX_FEATURE_ID)).toBeUndefined();
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
    'fails and leaves mcp.json untouched when it contains invalid JSON',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      writeProjectProperties(harness, server.baseUrl());
      harness.userHome.writeFile(MCP_CONFIG_PATH, '{ invalid json');

      const result = await harness.run('integrate pi --non-interactive');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('mcp.json contains invalid JSON');
      expect(harness.userHome.file(...MCP_CONFIG_PATH.split('/')).asText()).toBe('{ invalid json');
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
      await chooseCustomize(session);
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
