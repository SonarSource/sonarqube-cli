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

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  CONTEXT_AUGMENTATION_FEATURE_ID,
  SESSION_START_SCRIPT_REL,
} from '@/commands/integrate/_common/features/context-augmentation-feature.ts';
import {
  SQAA_HOOK_FEATURE_ID,
  SQAA_INSTRUCTIONS_SUBFEATURE_ID,
} from '@/commands/integrate/_common/features/sqaa-instructions-feature.ts';
import { VORTEX_FEATURE_ID } from '@/commands/integrate/_common/vortex.ts';
import { resolveDevinConfigDir } from '@/core/host/environment/devin-config-dir.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalCagBinaryName } from '@/core/host/install/context-augmentation.ts';
import type { CliState } from '@/core/state/state.ts';

import { TestHarness } from '../../harness';
import { buildHomeEnv, hookScriptName, hookScriptPath, SCRIPT_EXT } from '../../harness/platform';
import { findInstalledFeature, findInstalledSubfeature } from './state-helpers';

const TEST_ORG = 'my-org';
const SQAA_HEADING = '# Vortex analysis protocol';
const SQAA_BEGIN_MARKER = '<!-- sonar:begin:sonarqube-agentic-analysis-protocol -->';
const SECRETS_HEADING = '# SonarQube secrets scanning for files protocol';
const SECRETS_BEGIN_MARKER = '<!-- sonar:begin:devin-secrets-on-read -->';
const SECRETS_END_MARKER = '<!-- sonar:end:devin-secrets-on-read -->';

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
    'is listed in the integrate help and runs when typed explicitly',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');

      const integrateHelp = await harness.run('integrate --help');
      expect(integrateHelp.stdout + integrateHelp.stderr).toMatch(/devin/i);

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
    'is offered in the bare integrate agent picker',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');

      const session = harness.runInteractive('integrate');
      await session.waitText('Select the tool you want to integrate with');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.stdout + result.stderr).toContain('Devin');
    },
    { timeout: 15000 },
  );

  it(
    'lists Devin among the detected agents',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.userHome.writeFile('.codex/config.toml', '');
      writeDevinConfig(harness);

      const session = harness.runInteractive('integrate');
      await session.waitText('Detected agents on your machine: Codex, Devin');
      session.keyCtrlC();
      await session.waitFinish();
    },
    { timeout: 15000 },
  );

  it(
    'warns about a hook conflict when Claude and Devin are both detected',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.userHome.writeFile('.claude.json', '{}');
      writeDevinConfig(harness);

      const session = harness.runInteractive('integrate');
      await session.waitText('Select the tool you want to integrate with');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.stdout + result.stderr).toContain(
        "Both Claude Code and Devin were detected on this machine — integrating both can conflict at the hook level. Run 'sonar integrate' again anytime to add or remove one.",
      );
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

  describe('secrets hooks', () => {
    const USER_PRE_HOOK = {
      matcher: '^exec$',
      hooks: [{ type: 'command', command: './scripts/check.sh', timeout: 5 }],
    };
    const USER_PROMPT_HOOK = {
      matcher: '',
      hooks: [{ type: 'command', command: './scripts/log-prompt.sh', timeout: 5 }],
    };

    function secretsScriptRelPath(name: string): string {
      return devinConfigRelPath(
        harness,
        join('hooks', 'sonar-secrets', 'build-scripts', hookScriptName(name)),
      );
    }

    async function authenticate(): Promise<void> {
      const server = await harness.newFakeServer().withAuthToken('tok').start();
      harness.withAuth(server.baseUrl(), 'tok');
    }

    function secretsEntries(config: DevinConfigFile, event: string) {
      return (config.hooks?.[event] ?? []).filter((entry) =>
        entry.hooks?.some((hook) => hook.command?.includes('sonar-secrets')),
      );
    }

    it(
      'adds the PreToolUse read and UserPromptSubmit hooks to config.json and keeps the user settings and hooks',
      async () => {
        await authenticate();
        const configPath = devinConfigRelPath(harness, 'config.json');
        harness.userHome.writeFile(
          configPath,
          JSON.stringify({
            theme: 'dark',
            hooks: { PreToolUse: [USER_PRE_HOOK], UserPromptSubmit: [USER_PROMPT_HOOK] },
          }),
        );

        const result = await harness.run('integrate devin --non-interactive');

        expect(result.exitCode).toBe(0);
        const config: DevinConfigFile = harness.userHome.file(configPath).asJson();
        expect(config.theme).toBe('dark');
        expect(config.hooks?.PreToolUse?.[0]).toEqual(USER_PRE_HOOK);
        expect(config.hooks?.UserPromptSubmit?.[0]).toEqual(USER_PROMPT_HOOK);

        const preEntries = secretsEntries(config, 'PreToolUse');
        expect(preEntries).toHaveLength(1);
        expect(preEntries[0].matcher).toBe('^read$');
        const [preHook] = preEntries[0].hooks ?? [];
        expect(preHook.type).toBe('command');
        expect(preHook.timeout).toBe(60);
        expect(hookScriptPath(preHook.command ?? '')).toBe(
          join(harness.userHome.path, secretsScriptRelPath('pretool-secrets')).replaceAll(
            '\\',
            '/',
          ),
        );

        const promptEntries = secretsEntries(config, 'UserPromptSubmit');
        expect(promptEntries).toHaveLength(1);
        expect(promptEntries[0].matcher).toBe('');
        const [promptHook] = promptEntries[0].hooks ?? [];
        expect(hookScriptPath(promptHook.command ?? '')).toBe(
          join(harness.userHome.path, secretsScriptRelPath('prompt-secrets')).replaceAll('\\', '/'),
        );
        expect(harness.userHome.exists(devinConfigRelPath(harness, 'hooks.v1.json'))).toBe(false);
        expect(
          findInstalledFeature(harness, 'devin', 'sonar-secrets-hooks', 'global'),
        ).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'creates config.json when the Devin config directory has none',
      async () => {
        await authenticate();
        const configPath = devinConfigRelPath(harness, 'config.json');
        expect(harness.userHome.exists(configPath)).toBe(false);

        const result = await harness.run('integrate devin --non-interactive');

        expect(result.exitCode).toBe(0);
        const config: DevinConfigFile = harness.userHome.file(configPath).asJson();
        expect(secretsEntries(config, 'PreToolUse')).toHaveLength(1);
        expect(secretsEntries(config, 'UserPromptSubmit')).toHaveLength(1);
      },
      { timeout: 30000 },
    );

    it(
      'writes the hook scripts that run the devin secrets handlers',
      async () => {
        await authenticate();

        const result = await harness.run('integrate devin --non-interactive');

        expect(result.exitCode).toBe(0);
        const preScript = harness.userHome.file(secretsScriptRelPath('pretool-secrets'));
        const promptScript = harness.userHome.file(secretsScriptRelPath('prompt-secrets'));
        expect(preScript.isExecutable).toBe(true);
        expect(promptScript.isExecutable).toBe(true);
        expect(preScript.asText()).toContain('sonar hook devin-pre-tool-use');
        expect(promptScript.asText()).toContain('sonar hook devin-prompt-submit');
      },
      { timeout: 30000 },
    );

    it(
      'writes the secrets-on-read instructions to the global AGENTS.md and keeps the user content',
      async () => {
        await authenticate();
        const agentsPath = devinConfigRelPath(harness, 'AGENTS.md');
        const userContent = '# My rules\n\nAlways use tabs.\n';
        harness.userHome.writeFile(agentsPath, userContent);

        const result = await harness.run('integrate devin --non-interactive');

        expect(result.exitCode).toBe(0);
        const body = harness.userHome.file(agentsPath).asText();
        expect(body.startsWith(userContent)).toBe(true);
        expect(body).toContain(SECRETS_BEGIN_MARKER);
        expect(body).toContain(SECRETS_HEADING);
        expect(body).toContain('sonar analyze secrets <path/to/file>');
        expect(harness.cwd.exists('AGENTS.md')).toBe(false);
        expect(
          findInstalledFeature(harness, 'devin', 'secrets-instructions', 'global'),
        ).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'is idempotent: re-running leaves one entry per event and one instructions block',
      async () => {
        await authenticate();
        const configPath = devinConfigRelPath(harness, 'config.json');
        const agentsPath = devinConfigRelPath(harness, 'AGENTS.md');

        await harness.run('integrate devin --non-interactive');
        const firstConfig = harness.userHome.file(configPath).asJson();
        const firstAgents = harness.userHome.file(agentsPath).asText();
        const result = await harness.run('integrate devin --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.file(configPath).asJson()).toEqual(firstConfig);
        expect(harness.userHome.file(agentsPath).asText()).toBe(firstAgents);
        expect(firstAgents.split(SECRETS_BEGIN_MARKER)).toHaveLength(2);
      },
      { timeout: 30000 },
    );

    it(
      'system reset removes only the secrets hooks, scripts and instructions block',
      async () => {
        await authenticate();
        const configPath = devinConfigRelPath(harness, 'config.json');
        const agentsPath = devinConfigRelPath(harness, 'AGENTS.md');
        harness.userHome.writeFile(
          configPath,
          JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [USER_PRE_HOOK] } }),
        );
        harness.userHome.writeFile(agentsPath, '# My rules\n');
        await harness.run('integrate devin --non-interactive');
        expect(harness.userHome.exists(secretsScriptRelPath('pretool-secrets'))).toBe(true);
        expect(harness.userHome.file(agentsPath).asText()).toContain(SECRETS_END_MARKER);
        harness.state().withRawState(readFileSync(harness.stateJsonFile.path, 'utf-8'));

        const result = await harness.run('system reset --force');

        expect(result.exitCode).toBe(0);
        const config: DevinConfigFile = harness.userHome.file(configPath).asJson();
        expect(config.theme).toBe('dark');
        expect(config.hooks?.PreToolUse).toEqual([USER_PRE_HOOK]);
        expect(secretsEntries(config, 'UserPromptSubmit')).toHaveLength(0);
        expect(harness.userHome.exists(secretsScriptRelPath('pretool-secrets'))).toBe(false);
        expect(harness.userHome.exists(secretsScriptRelPath('prompt-secrets'))).toBe(false);
        const agents = harness.userHome.file(agentsPath).asText();
        expect(agents).toContain('# My rules');
        expect(agents).not.toContain(SECRETS_HEADING);
      },
      { timeout: 30000 },
    );
  });

  describe('Vortex per-edit analysis', () => {
    const USER_HOOK = {
      matcher: '^exec$',
      hooks: [{ type: 'command', command: './scripts/check.sh', timeout: 5 }],
    };

    const USER_SESSION_START_HOOK = {
      matcher: '',
      hooks: [{ type: 'command', command: './scripts/session.sh', timeout: 5 }],
    };

    function sessionStartScriptRelPath(): string {
      return devinConfigRelPath(harness, join('hooks', SESSION_START_SCRIPT_REL)) + SCRIPT_EXT;
    }

    function isSecretsEntry(entry: { hooks?: Array<{ command?: string }> }): boolean {
      return entry.hooks?.some((hook) => hook.command?.includes('sonar-secrets')) === true;
    }

    function readConfig(configPath: string): DevinConfigFile {
      const config: DevinConfigFile = harness.userHome.file(configPath).asJson();
      return config;
    }

    function sessionStartEntries(config: DevinConfigFile) {
      return (config.hooks?.SessionStart ?? []).filter((entry) =>
        entry.hooks?.some((hook) => hook.command?.includes('sonar-vortex')),
      );
    }

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
        const config: DevinConfigFile = harness.userHome.file(configPath).asJson();
        expect(config.theme).toBe('dark');
        expect(config.hooks?.PostToolUse).toBeUndefined();
        expect(harness.userHome.exists(sqaaScriptRelPath())).toBe(false);
        expect(
          harness.userHome.file(devinConfigRelPath(harness, 'AGENTS.md')).asText(),
        ).not.toContain(SQAA_HEADING);
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
          JSON.stringify({
            theme: 'dark',
            hooks: { PostToolUse: [USER_HOOK], SessionStart: [USER_SESSION_START_HOOK] },
          }),
        );
        harness.userHome.writeFile(agentsPath, '# My rules\n');
        await harness.run('integrate devin --non-interactive', { extraEnv });
        expect(harness.userHome.exists(sqaaScriptRelPath())).toBe(true);
        expect(harness.userHome.exists(sessionStartScriptRelPath())).toBe(true);
        expect(sessionStartEntries(readConfig(configPath))).toHaveLength(1);
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
        expect(config.hooks?.SessionStart).toEqual([USER_SESSION_START_HOOK]);
        expect(config.hooks?.UserPromptSubmit?.some(isSecretsEntry)).toBe(true);
        expect(harness.userHome.exists(sqaaScriptRelPath())).toBe(false);
        expect(harness.userHome.exists(sessionStartScriptRelPath())).toBe(false);
        expect(harness.userHome.file(agentsPath).asText()).not.toContain(SQAA_HEADING);
        expect(harness.userHome.file(agentsPath).asText()).toContain('# My rules');
      },
      { timeout: 30000 },
    );
    describe('session-start announcement', () => {
      it(
        'adds the SessionStart hook to config.json and keeps the user settings and hooks',
        async () => {
          const { extraEnv } = await startEntitledCloudServer();
          const configPath = devinConfigRelPath(harness, 'config.json');
          harness.userHome.writeFile(
            configPath,
            JSON.stringify({
              theme: 'dark',
              hooks: { SessionStart: [USER_SESSION_START_HOOK], PostToolUse: [USER_HOOK] },
            }),
          );

          const result = await harness.run('integrate devin --non-interactive', { extraEnv });

          expect(result.exitCode).toBe(0);
          const config: DevinConfigFile = harness.userHome.file(configPath).asJson();
          expect(config.theme).toBe('dark');
          expect(config.hooks?.PostToolUse?.[0]).toEqual(USER_HOOK);
          expect(config.hooks?.SessionStart?.[0]).toEqual(USER_SESSION_START_HOOK);
          const entries = sessionStartEntries(config);
          expect(entries).toHaveLength(1);
          expect(entries[0].matcher).toBe('');
          const [hook] = entries[0].hooks ?? [];
          expect(hook.type).toBe('command');
          expect(hook.timeout).toBe(60);
          expect(hookScriptPath(hook.command ?? '')).toBe(
            join(harness.userHome.path, sessionStartScriptRelPath()).replaceAll('\\', '/'),
          );
          expect(config.hooks).not.toHaveProperty('SubagentStart');
        },
        { timeout: 30000 },
      );

      it(
        'writes the hook script that runs sonar hook agent-session-start --agent devin and installs the CAG binary',
        async () => {
          const { extraEnv } = await startEntitledCloudServer();
          const cagBinary = harness.cliHome.file('bin', buildLocalCagBinaryName(detectPlatform()));
          expect(cagBinary.exists()).toBe(false);

          const result = await harness.run('integrate devin --non-interactive', { extraEnv });

          expect(result.exitCode).toBe(0);
          const script = harness.userHome.file(sessionStartScriptRelPath());
          expect(script.exists()).toBe(true);
          expect(script.isExecutable).toBe(true);
          expect(script.asText()).toContain('sonar hook agent-session-start --agent devin');
          expect(cagBinary.exists()).toBe(true);
          const state = harness.stateJsonFile.asJson() as CliState;
          expect(
            state.dependencies.installed.some((d) => d.id === 'sonar-context-augmentation'),
          ).toBe(true);
          expect(
            findInstalledSubfeature(
              harness,
              'devin',
              VORTEX_FEATURE_ID,
              CONTEXT_AUGMENTATION_FEATURE_ID,
            ),
          ).toBeDefined();
          expect(harness.userHome.exists(devinConfigRelPath(harness, 'skills'))).toBe(false);
        },
        { timeout: 30000 },
      );

      it(
        'is idempotent: re-running leaves one SessionStart entry',
        async () => {
          const { extraEnv } = await startEntitledCloudServer();
          const configPath = devinConfigRelPath(harness, 'config.json');

          await harness.run('integrate devin --non-interactive', { extraEnv });
          expect(sessionStartEntries(readConfig(configPath))).toHaveLength(1);
          const result = await harness.run('integrate devin --non-interactive', { extraEnv });

          expect(result.exitCode).toBe(0);
          expect(sessionStartEntries(readConfig(configPath))).toHaveLength(1);
        },
        { timeout: 30000 },
      );

      it(
        'installs no session-start hook, script or CAG binary when the organization has no Vortex',
        async () => {
          const server = await harness.newFakeServer().withAuthToken('tok').start();
          harness.withAuth(server.baseUrl(), 'tok');

          const result = await harness.run('integrate devin --non-interactive');

          expect(result.exitCode).toBe(0);
          const configPath = devinConfigRelPath(harness, 'config.json');
          const config: DevinConfigFile = harness.userHome.file(configPath).asJson();
          expect(config.hooks?.SessionStart).toBeUndefined();
          expect(harness.userHome.exists(sessionStartScriptRelPath())).toBe(false);
          expect(
            harness.cliHome.file('bin', buildLocalCagBinaryName(detectPlatform())).exists(),
          ).toBe(false);
        },
        { timeout: 30000 },
      );
    });

    describe('subagent announcement', () => {
      const USER_PRE_TOOL_HOOK = {
        matcher: '^exec$',
        hooks: [{ type: 'command', command: './scripts/pre-exec.sh', timeout: 5 }],
      };

      function subagentScriptRelPath(): string {
        return (
          devinConfigRelPath(
            harness,
            join('hooks', 'sonar-vortex', 'build-scripts', 'subagent-start-vortex'),
          ) + SCRIPT_EXT
        );
      }

      function subagentEntries(config: DevinConfigFile) {
        return (config.hooks?.PreToolUse ?? []).filter((entry) =>
          entry.hooks?.some((hook) => hook.command?.includes('sonar-vortex')),
        );
      }

      it(
        'adds the run_subagent PreToolUse hook next to the secrets read hook and the user hooks',
        async () => {
          const { extraEnv } = await startEntitledCloudServer();
          const configPath = devinConfigRelPath(harness, 'config.json');
          harness.userHome.writeFile(
            configPath,
            JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [USER_PRE_TOOL_HOOK] } }),
          );

          const result = await harness.run('integrate devin --non-interactive', { extraEnv });

          expect(result.exitCode).toBe(0);
          const config = readConfig(configPath);
          expect(config.theme).toBe('dark');
          const preToolUse = config.hooks?.PreToolUse ?? [];
          expect(preToolUse[0]).toEqual(USER_PRE_TOOL_HOOK);
          const secrets = preToolUse.filter(isSecretsEntry);
          expect(secrets).toHaveLength(1);
          expect(secrets[0].matcher).toBe('^read$');
          const entries = subagentEntries(config);
          expect(entries).toHaveLength(1);
          expect(entries[0].matcher).toBe('^run_subagent$');
          const [hook] = entries[0].hooks ?? [];
          expect(hook.type).toBe('command');
          expect(hook.timeout).toBe(60);
          expect(hookScriptPath(hook.command ?? '')).toBe(
            join(harness.userHome.path, subagentScriptRelPath()).replaceAll('\\', '/'),
          );
          expect(preToolUse).toHaveLength(3);
          expect(sessionStartEntries(config)).toHaveLength(1);
        },
        { timeout: 30000 },
      );

      it(
        'writes the hook script that runs sonar hook devin-subagent-start',
        async () => {
          const { extraEnv } = await startEntitledCloudServer();
          const script = harness.userHome.file(subagentScriptRelPath());
          expect(script.exists()).toBe(false);

          const result = await harness.run('integrate devin --non-interactive', { extraEnv });

          expect(result.exitCode).toBe(0);
          expect(script.exists()).toBe(true);
          expect(script.isExecutable).toBe(true);
          expect(script.asText()).toContain('sonar hook devin-subagent-start');
        },
        { timeout: 30000 },
      );

      it(
        'is idempotent: re-running leaves one run_subagent entry and one secrets read entry',
        async () => {
          const { extraEnv } = await startEntitledCloudServer();
          const configPath = devinConfigRelPath(harness, 'config.json');

          await harness.run('integrate devin --non-interactive', { extraEnv });
          expect(subagentEntries(readConfig(configPath))).toHaveLength(1);
          const result = await harness.run('integrate devin --non-interactive', { extraEnv });

          expect(result.exitCode).toBe(0);
          const config = readConfig(configPath);
          expect(subagentEntries(config)).toHaveLength(1);
          expect(config.hooks?.PreToolUse?.filter(isSecretsEntry)).toHaveLength(1);
        },
        { timeout: 30000 },
      );

      it(
        'installs no run_subagent hook or script when the organization has no Vortex',
        async () => {
          const server = await harness.newFakeServer().withAuthToken('tok').start();
          harness.withAuth(server.baseUrl(), 'tok');

          const result = await harness.run('integrate devin --non-interactive');

          expect(result.exitCode).toBe(0);
          const config = readConfig(devinConfigRelPath(harness, 'config.json'));
          expect(config.hooks?.PreToolUse?.some(isSecretsEntry)).toBe(true);
          expect(subagentEntries(config)).toHaveLength(0);
          expect(harness.userHome.exists(subagentScriptRelPath())).toBe(false);
        },
        { timeout: 30000 },
      );

      it(
        'removes only the run_subagent hook on entitlement loss, keeping the secrets and user hooks',
        async () => {
          const { extraEnv } = await startEntitledCloudServer();
          const configPath = devinConfigRelPath(harness, 'config.json');
          harness.userHome.writeFile(
            configPath,
            JSON.stringify({ hooks: { PreToolUse: [USER_PRE_TOOL_HOOK] } }),
          );
          await harness.run('integrate devin --non-interactive', { extraEnv });
          expect(subagentEntries(readConfig(configPath))).toHaveLength(1);
          expect(harness.userHome.exists(subagentScriptRelPath())).toBe(true);

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
            (connection: { id: string }) =>
              connection.id === installedState.auth.activeConnectionId,
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
          const config = readConfig(configPath);
          expect(subagentEntries(config)).toHaveLength(0);
          expect(config.hooks?.PreToolUse?.[0]).toEqual(USER_PRE_TOOL_HOOK);
          expect(config.hooks?.PreToolUse?.filter(isSecretsEntry)).toHaveLength(1);
          expect(harness.userHome.exists(subagentScriptRelPath())).toBe(false);
        },
        { timeout: 30000 },
      );
    });
  });
});
