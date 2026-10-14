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

// Integration tests for `sonar integrate devin`.

import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  SQAA_HOOK_FEATURE_ID,
  SQAA_INSTRUCTIONS_SUBFEATURE_ID,
} from '@/commands/integrate/_common/features/sqaa-instructions-feature.ts';
import { VORTEX_FEATURE_ID } from '@/commands/integrate/_common/vortex.ts';
import { resolveDevinConfigDir } from '@/core/host/environment/devin-config-dir.ts';

import { TestHarness } from '../../harness';
import { buildHomeEnv, hookScriptName, hookScriptPath } from '../../harness/platform';
import { findInstalledFeature, findInstalledSubfeature } from './state-helpers';

const TEST_ORG = 'my-org';
const SQAA_HEADING = '# Vortex analysis protocol';
const SQAA_BEGIN_MARKER = '<!-- sonar:begin:sonarqube-agentic-analysis-protocol -->';

interface DevinConfigFile {
  theme?: string;
  hooks?: Record<
    string,
    Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
    }>
  >;
}

// Devin's config dir is per-OS (~/.config/devin, %APPDATA%\devin on Windows); resolve it with the
// same env the harness gives the CLI so the test sets up what the detector will look for.
function writeDevinConfig(harness: TestHarness): void {
  const home = harness.userHome.path;
  const configDir = resolveDevinConfigDir(home, buildHomeEnv(home));
  harness.userHome.writeFile(join(relative(home, configDir), 'config.json'), '{}');
}

function devinConfigRelPath(harness: TestHarness, fileName: string): string {
  const home = harness.userHome.path;
  return join(relative(home, resolveDevinConfigDir(home, buildHomeEnv(home))), fileName);
}

describe('integrate devin', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
    await harness.newFakeBinariesServer().start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'is hidden from help output but still runs when typed explicitly',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');

      const rootHelp = await harness.run('');
      const integrateHelp = await harness.run('integrate --help');
      expect(rootHelp.stdout).not.toMatch(/devin/i);
      expect(integrateHelp.stdout + integrateHelp.stderr).not.toMatch(/devin/i);

      const result = await harness.run('integrate devin --non-interactive');
      expect(result.exitCode).toBe(0);
    },
    { timeout: 30000 },
  );

  it(
    'writes the sonarqube MCP server without a project key and keeps the user entries',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );
      const mcpConfigPath = devinConfigRelPath(harness, 'mcp_config.json');
      harness.userHome.writeFile(
        mcpConfigPath,
        JSON.stringify({
          theme: 'dark',
          mcpServers: { other: { command: 'other-mcp', args: ['--flag'] } },
        }),
      );

      const result = await harness.run('integrate devin --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.userHome.file(mcpConfigPath).asJson()).toEqual({
        theme: 'dark',
        mcpServers: {
          other: { command: 'other-mcp', args: ['--flag'] },
          sonarqube: { command: 'sonar', args: ['run', 'mcp'] },
        },
      });
      expect(findInstalledFeature(harness, 'devin', 'mcp-server', 'global')).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'creates mcp_config.json when the Devin config directory has none',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');

      const result = await harness.run('integrate devin --non-interactive');

      expect(result.exitCode).toBe(0);
      const mcpConfigPath = devinConfigRelPath(harness, 'mcp_config.json');
      expect(harness.userHome.file(mcpConfigPath).asJson()).toEqual({
        mcpServers: { sonarqube: { command: 'sonar', args: ['run', 'mcp'] } },
      });
    },
    { timeout: 30000 },
  );

  describe('-g/--global (deprecated no-op)', () => {
    it(
      'documents --global as deprecated in --help',
      async () => {
        const result = await harness.run('integrate devin --help');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('--non-interactive');
        expect(result.stdout).toContain('--global');
        expect(result.stdout).toContain('[DEPRECATED]');
      },
      { timeout: 15000 },
    );

    it(
      'warns that --global is deprecated but still completes the (already global) install',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        const result = await harness.run('integrate devin --non-interactive --global');

        expect(result.stderr).toContain(
          "'--global' is deprecated since 1.9.0 and will be removed in a future version. Use 'sonar integrate devin' instead.",
        );
        expect(result.exitCode).toBe(0);
      },
      { timeout: 30000 },
    );
  });

  it(
    'is not offered in the bare integrate agent picker',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');

      const session = harness.runInteractive('integrate');
      await session.waitText('Select the tool you want to integrate with');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.stdout + result.stderr).not.toContain('Devin');
    },
    { timeout: 15000 },
  );

  it(
    'does not list Devin as detected while its integration is unreleased',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.userHome.writeFile('.codex/config.toml', '');
      writeDevinConfig(harness);

      const session = harness.runInteractive('integrate');
      await session.waitText('Detected agents on your machine: Codex');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.stdout + result.stderr).not.toContain('Devin');
    },
    { timeout: 15000 },
  );

  it(
    'does not warn about a Claude and Devin conflict while Devin is unreleased',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.userHome.writeFile('.claude.json', '{}');
      writeDevinConfig(harness);

      const session = harness.runInteractive('integrate');
      await session.waitText('Select the tool you want to integrate with');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.stdout + result.stderr).not.toContain('Devin');
    },
    { timeout: 15000 },
  );

  it(
    'is idempotent: re-running leaves a single identical sonarqube entry',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');
      const mcpConfigPath = devinConfigRelPath(harness, 'mcp_config.json');

      await harness.run('integrate devin --non-interactive');
      const first = harness.userHome.file(mcpConfigPath).asJson();
      const result = await harness.run('integrate devin --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.userHome.file(mcpConfigPath).asJson()).toEqual(first);
    },
    { timeout: 30000 },
  );

  it(
    'fails and leaves the file untouched when mcp_config.json holds invalid JSON',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');
      const mcpConfigPath = devinConfigRelPath(harness, 'mcp_config.json');
      harness.userHome.writeFile(mcpConfigPath, '{ invalid json');

      const result = await harness.run('integrate devin --non-interactive');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('mcp_config.json contains invalid JSON');
      expect(harness.userHome.file(mcpConfigPath).asText()).toBe('{ invalid json');
    },
    { timeout: 30000 },
  );

  describe('Vortex per-edit analysis', () => {
    const USER_HOOK = {
      matcher: '^exec$',
      hooks: [{ type: 'command', command: './scripts/check.sh', timeout: 5 }],
    };

    async function startEntitledCloudServer(): Promise<{ extraEnv: Record<string, string> }> {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
        .withVortexEntitlement(TEST_ORG, 'test-uuid-1234')
        .start();
      harness.withAuth(server.baseUrl(), 'cloud-token', TEST_ORG);
      return {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
          SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
        },
      };
    }

    function sqaaScriptRelPath(): string {
      return devinConfigRelPath(
        harness,
        join('hooks', 'sonar-sqaa', 'build-scripts', hookScriptName('posttool-sqaa')),
      );
    }

    it(
      'adds the PostToolUse hook to config.json and keeps the user settings and hooks',
      async () => {
        const { extraEnv } = await startEntitledCloudServer();
        const configPath = devinConfigRelPath(harness, 'config.json');
        harness.userHome.writeFile(
          configPath,
          JSON.stringify({ theme: 'dark', hooks: { PostToolUse: [USER_HOOK] } }),
        );

        const result = await harness.run('integrate devin --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        const config: DevinConfigFile = harness.userHome.file(configPath).asJson();
        expect(config.theme).toBe('dark');
        const postToolUse = config.hooks?.PostToolUse ?? [];
        expect(postToolUse[0]).toEqual(USER_HOOK);
        const sqaaEntries = postToolUse.filter((entry) =>
          entry.hooks?.some((hook) => hook.command?.includes('sonar-sqaa')),
        );
        expect(sqaaEntries).toHaveLength(1);
        expect(sqaaEntries[0].matcher).toBe('^(edit|write)$');
        const [hook] = sqaaEntries[0].hooks ?? [];
        expect(hook.type).toBe('command');
        expect(hook.timeout).toBe(60);
        expect(hookScriptPath(hook.command ?? '')).toBe(
          join(harness.userHome.path, sqaaScriptRelPath()).replaceAll('\\', '/'),
        );
        expect(harness.userHome.exists(devinConfigRelPath(harness, 'hooks.v1.json'))).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'writes the hook script that runs sonar hook devin-post-tool-use',
      async () => {
        const { extraEnv } = await startEntitledCloudServer();

        const result = await harness.run('integrate devin --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        const script = harness.userHome.file(sqaaScriptRelPath());
        expect(script.exists()).toBe(true);
        expect(script.isExecutable).toBe(true);
        expect(script.asText()).toContain('sonar hook devin-post-tool-use');
        expect(
          findInstalledSubfeature(harness, 'devin', VORTEX_FEATURE_ID, SQAA_HOOK_FEATURE_ID),
        ).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'writes the Vortex analysis protocol to the global AGENTS.md and keeps the user content',
      async () => {
        const { extraEnv } = await startEntitledCloudServer();
        const agentsPath = devinConfigRelPath(harness, 'AGENTS.md');
        const userContent = '# My rules\n\nAlways use tabs.\n';
        harness.userHome.writeFile(agentsPath, userContent);

        const result = await harness.run('integrate devin --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        const body = harness.userHome.file(agentsPath).asText();
        expect(body.startsWith(userContent)).toBe(true);
        expect(body).toContain(SQAA_BEGIN_MARKER);
        expect(body).toContain(SQAA_HEADING);
        expect(body).toContain('sonar analyze agentic --depth DEEP');
        expect(harness.cwd.exists('AGENTS.md')).toBe(false);
        expect(
          findInstalledSubfeature(
            harness,
            'devin',
            VORTEX_FEATURE_ID,
            SQAA_INSTRUCTIONS_SUBFEATURE_ID,
          ),
        ).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'is idempotent: re-running leaves one hook entry and one protocol block',
      async () => {
        const { extraEnv } = await startEntitledCloudServer();
        const configPath = devinConfigRelPath(harness, 'config.json');
        const agentsPath = devinConfigRelPath(harness, 'AGENTS.md');

        await harness.run('integrate devin --non-interactive', { extraEnv });
        const firstConfig = harness.userHome.file(configPath).asJson();
        const firstAgents = harness.userHome.file(agentsPath).asText();
        const result = await harness.run('integrate devin --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.file(configPath).asJson()).toEqual(firstConfig);
        expect(harness.userHome.file(agentsPath).asText()).toBe(firstAgents);
        expect(firstAgents.split(SQAA_BEGIN_MARKER)).toHaveLength(2);
      },
      { timeout: 30000 },
    );

    it(
      'installs no Vortex files and shows the promotion when the organization has no Vortex',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');
        const configPath = devinConfigRelPath(harness, 'config.json');
        harness.userHome.writeFile(configPath, JSON.stringify({ theme: 'dark' }));

        const result = await harness.run('integrate devin --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.file(configPath).asJson()).toEqual({ theme: 'dark' });
        expect(harness.userHome.exists(sqaaScriptRelPath())).toBe(false);
        expect(harness.userHome.exists(devinConfigRelPath(harness, 'AGENTS.md'))).toBe(false);
        expect(findInstalledFeature(harness, 'devin', VORTEX_FEATURE_ID)).toBeUndefined();
        expect(result.stdout + result.stderr).toContain(
          'Vortex requires SonarQube Server 2026.5 Enterprise or later.',
        );
      },
      { timeout: 30000 },
    );

    it(
      'removes only the Vortex files when the organization loses its Vortex entitlement',
      async () => {
        const { extraEnv } = await startEntitledCloudServer();
        const configPath = devinConfigRelPath(harness, 'config.json');
        const agentsPath = devinConfigRelPath(harness, 'AGENTS.md');
        harness.userHome.writeFile(
          configPath,
          JSON.stringify({ theme: 'dark', hooks: { PostToolUse: [USER_HOOK] } }),
        );
        harness.userHome.writeFile(agentsPath, '# My rules\n');
        await harness.run('integrate devin --non-interactive', { extraEnv });
        expect(harness.userHome.exists(sqaaScriptRelPath())).toBe(true);
        expect(harness.userHome.file(agentsPath).asText()).toContain(SQAA_HEADING);

        const installedState = harness.stateJsonFile.asJson();
        const lostServer = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
          .withVortexEntitlement(TEST_ORG, 'test-uuid-1234', {
            allowed: false,
            hasEntitlement: false,
          })
          .start();
        const activeConnection = installedState.auth.connections.find(
          (connection: { id: string }) => connection.id === installedState.auth.activeConnectionId,
        );
        activeConnection.serverUrl = lostServer.baseUrl();
        harness.state().withRawState(JSON.stringify(installedState));
        const result = await harness.run('integrate devin --non-interactive', {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: lostServer.baseUrl(),
            SONARQUBE_CLI_SONARCLOUD_API_URL: lostServer.baseUrl(),
          },
        });

        expect(result.exitCode).toBe(0);
        const config: DevinConfigFile = harness.userHome.file(configPath).asJson();
        expect(config.theme).toBe('dark');
        expect(config.hooks?.PostToolUse).toEqual([USER_HOOK]);
        expect(harness.userHome.exists(sqaaScriptRelPath())).toBe(false);
        expect(harness.userHome.file(agentsPath).asText()).not.toContain(SQAA_HEADING);
        expect(harness.userHome.file(agentsPath).asText()).toContain('# My rules');
      },
      { timeout: 30000 },
    );
  });
});
