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

// Integration tests for `sonar integrate copilot`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  expectAgentPromptHint,
  expectNoAgentPromptHint,
} from '../../../_common/agent-hint-assertions.js';
import { type CliResult, normalizePath, TestHarness } from '../../harness';
import {
  CopilotHookEntry,
  CopilotHooksJson,
  findCopilotFeature,
  getCopilotIntegration,
  GLOBAL_HOOK_SCRIPT_PATH,
  GLOBAL_HOOKS_JSON_PATH,
  GLOBAL_INSTRUCTIONS_PATH,
  GLOBAL_PROMPT_HOOK_SCRIPT_PATH,
  HOOK_FIELD,
  makeHookEntry,
  McpJson,
} from './copilot-test-helpers';
import { chooseCustomize } from './integrate-test-helpers';

describe('integrate copilot', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
    const server = await harness.newFakeServer().withAuthToken('tok').start();
    harness.withAuth(server.baseUrl(), 'tok');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  // ─── Install (default: global) ──────────────────────────────────────────────
  //
  // `sonar integrate copilot` always installs globally under `~/.copilot/` —
  // there is no project-scoped install mode and no `-p` flag. `-g`/`--global`
  // is accepted only as a deprecated no-op for backwards compatibility.

  describe('install (default: global)', () => {
    it(
      'writes executable read and prompt hooks, hooks.json, and mcp-config.json under ~/.copilot/',
      async () => {
        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(0);

        const scriptFile = harness.userHome.file(...GLOBAL_HOOK_SCRIPT_PATH);
        expect(scriptFile.exists()).toBe(true);
        expect(scriptFile.isExecutable).toBe(true);

        expect(harness.userHome.exists('.copilot', 'hooks', 'hooks.json')).toBe(true);

        const promptScript = harness.userHome.file(...GLOBAL_PROMPT_HOOK_SCRIPT_PATH);
        expect(promptScript.exists()).toBe(true);
        expect(promptScript.isExecutable).toBe(true);
        expect(promptScript.asText()).toContain('sonar hook copilot-prompt-transformed');
        expect(harness.userHome.exists(...GLOBAL_INSTRUCTIONS_PATH)).toBe(false);

        // mcp-config.json: present and registers the sonarqube MCP server using
        // the PATH command `sonar` (Windows PATHEXT resolves sonar.exe).
        expect(harness.userHome.exists('.copilot', 'mcp-config.json')).toBe(true);
        const mcp: McpJson = harness.userHome.file('.copilot', 'mcp-config.json').asJson();
        const sonar = mcp.mcpServers?.sonarqube;
        expect(sonar?.command).toBe('sonar');
        expect(sonar?.args?.slice(0, 2)).toEqual(['run', 'mcp']);

        // Nothing is written into the project directory.
        expect(harness.cwd.exists('.github', 'hooks')).toBe(false);
        expect(harness.cwd.exists('.github', 'instructions')).toBe(false);
        expect(harness.cwd.exists('.mcp.json')).toBe(false);

        // Completion summary
        expect(result.stdout).toContain('Installed');
        expect(result.stdout).toContain('Setup complete!');
        expect(result.stdout).toContain('paste this into Copilot');
      },
      { timeout: 30000 },
    );

    it(
      'uses an absolute path in the hooks.json preToolUse entry, with timeoutSec=60',
      async () => {
        await harness.run('integrate copilot --non-interactive');

        const json = harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        expect(json.hooks.preToolUse).toHaveLength(1);
        const entry = json.hooks.preToolUse?.[0] ?? ({} as CopilotHookEntry);
        expect(entry.type).toBe('command');
        expect(entry.timeoutSec).toBe(60);
        const command = normalizePath(String(entry[HOOK_FIELD] ?? ''));
        const homePathNorm = normalizePath(harness.userHome.path);
        expect(command.startsWith(homePathNorm)).toBe(true);
        expect(command).toContain('.copilot/hooks/sonar-secrets');
        expect(command).toContain('pretool-secrets');
        expect(json.hooks.userPromptTransformed).toHaveLength(1);
        const promptEntry = json.hooks.userPromptTransformed?.[0];
        expect(promptEntry?.type).toBe('command');
        expect(promptEntry?.timeoutSec).toBe(60);
        expect(normalizePath(promptEntry?.[HOOK_FIELD] ?? '')).toBe(
          normalizePath(harness.userHome.file(...GLOBAL_PROMPT_HOOK_SCRIPT_PATH).path),
        );
      },
      { timeout: 30000 },
    );

    it(
      'records default features as global-scope in integrations.installed',
      async () => {
        await harness.run('integrate copilot --non-interactive');

        const copilotIntegration = getCopilotIntegration(harness);
        expect(copilotIntegration).toBeDefined();
        expect(
          copilotIntegration?.features
            .map((feature: { featureId: string }) => feature.featureId)
            .sort(),
        ).toEqual(['mcp-server', 'pre-tool-use-hook', 'prompt-secrets-hook']);
        expect(findCopilotFeature(harness, 'pre-tool-use-hook')?.scope).toBe('global');
        expect(findCopilotFeature(harness, 'prompt-secrets-hook')?.scope).toBe('global');
      },
      { timeout: 30000 },
    );

    it(
      'running twice yields exactly one entry for each secrets hook in hooks.json',
      async () => {
        await harness.run('integrate copilot --non-interactive');
        await harness.run('integrate copilot --non-interactive');

        const json = harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        expect(json.hooks.preToolUse).toHaveLength(1);
        expect(json.hooks.userPromptTransformed).toHaveLength(1);
      },
      { timeout: 60000 },
    );

    it(
      'pretool-secrets script uses the correct subcommand (sonar hook copilot-pre-tool-use)',
      async () => {
        await harness.run('integrate copilot --non-interactive');

        const content = harness.userHome.file(...GLOBAL_HOOK_SCRIPT_PATH).asText();
        expect(content).toContain('sonar hook copilot-pre-tool-use');
        expect(content).not.toContain('sonar analyze');
      },
      { timeout: 30000 },
    );

    it(
      'preserves unrelated preToolUse entries in a pre-existing global hooks.json',
      async () => {
        harness.userHome.writeFile(
          '.copilot/hooks/hooks.json',
          JSON.stringify({
            version: 1,
            hooks: {
              preToolUse: [makeHookEntry('/other/tool/run.sh')],
              userPromptTransformed: [makeHookEntry('/other/tool/prompt.sh')],
            },
          }),
        );

        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(0);
        const json = harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        const entries = json.hooks.preToolUse ?? [];
        expect(entries).toHaveLength(2);
        expect(entries.find((e) => (e[HOOK_FIELD] ?? '').includes('/other/tool/'))).toBeDefined();
        expect(entries.find((e) => (e[HOOK_FIELD] ?? '').includes('sonar-secrets'))).toBeDefined();
        expect(json.hooks.userPromptTransformed).toHaveLength(2);
        expect(json.hooks.userPromptTransformed?.[0]?.[HOOK_FIELD]).toBe('/other/tool/prompt.sh');
      },
      { timeout: 30000 },
    );

    it(
      'initialises the hooks key when a pre-existing hooks.json lacks it',
      async () => {
        // Bare hooks.json with no top-level `hooks` key. The install must
        // initialise `hooks` (via `hooksJson.hooks ??= {}`) without crashing
        // and without dropping the existing `version` field.
        harness.userHome.writeFile('.copilot/hooks/hooks.json', JSON.stringify({ version: 1 }));

        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(0);
        const json = harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        expect(json.version).toBe(1);
        const entries = json.hooks.preToolUse ?? [];
        expect(entries).toHaveLength(1);
        expect(entries[0][HOOK_FIELD] ?? '').toContain('sonar-secrets');
      },
      { timeout: 30000 },
    );
  });

  // ─── SQAA section in the instructions file ──────────────────────────────────

  describe('SQAA section in the instructions file', () => {
    const TEST_ORG = 'my-org';
    const TEST_PROJECT = 'my-project';
    const HTTP_SERVICE_UNAVAILABLE = 503;
    /**
     * Stand up a fake SonarQube Cloud server with Vortex entitlement configured
     * for the test org, swap the harness auth to a cloud connection, and
     * return env vars that point the CLI's hard-coded SonarCloud URL
     * constants at the fake server (so `isSonarQubeCloud(serverUrl)` and the
     * entitlement endpoint both resolve to the fake).
     */
    async function setupCloudWithEntitlement(
      options: { allowed?: boolean; hasEntitlement?: boolean } = {},
    ): Promise<{ extraEnv: Record<string, string> }> {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
        .withVortexEntitlement(TEST_ORG, 'test-uuid-1234', options)
        .withProject(TEST_PROJECT)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);
      return {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      };
    }

    it(
      'installs prompt scanning alongside SQAA instructions when the org is entitled',
      async () => {
        harness.state().withContextAugmentationBinaryInstalled();
        const { extraEnv } = await setupCloudWithEntitlement();
        harness.cwd.writeFile('sonar-project.properties', `sonar.projectKey=${TEST_PROJECT}\n`);

        const result = await harness.run('integrate copilot --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        const body = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();
        expect(body).not.toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).toContain('# Vortex analysis protocol');
        expect(body).toContain('sonar analyze agentic --depth DEEP');
        expect(body).toContain('--file');

        const promptSecrets = findCopilotFeature(harness, 'prompt-secrets-hook');
        expect(promptSecrets?.scope).toBe('global');
        expect(findCopilotFeature(harness, 'vortex')?.scope).toBe('global');
      },
      { timeout: 30000 },
    );

    it(
      'prompts to install Vortex and writes the SQAA section when accepted (entitled org, interactive)',
      async () => {
        const { extraEnv } = await setupCloudWithEntitlement();

        // Interactive (no --non-interactive): the entitled org makes Vortex an ask.
        const session = harness.runInteractive('integrate copilot', {
          extraEnv: { ...extraEnv, __SQCLI_DEV_SKIP_CAG: '1' },
        });
        await chooseCustomize(session);
        await session.accept('Install pre-tool-use hook?');
        await session.accept('Install prompt-secrets hook?');
        await session.accept('Install Vortex?');
        await session.accept('Install MCP server?');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Install Vortex?');
        const body = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# Vortex analysis protocol');
        expect(findCopilotFeature(harness, 'vortex')?.scope).toBe('global');
      },
      { timeout: 30000 },
    );

    it(
      'writes the SQAA section when no project key is discoverable',
      async () => {
        const { extraEnv } = await setupCloudWithEntitlement();

        const result = await harness.run('integrate copilot --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        const body = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();
        expect(body).not.toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).toContain('# Vortex analysis');
        expect(findCopilotFeature(harness, 'vortex')?.scope).toBe('global');
      },
      { timeout: 30000 },
    );

    it(
      'omits the SQAA section when the org is not entitled to Vortex',
      async () => {
        const { extraEnv } = await setupCloudWithEntitlement({
          allowed: false,
          hasEntitlement: false,
        });

        const result = await harness.run('integrate copilot --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.exists(...GLOBAL_INSTRUCTIONS_PATH)).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'omits the SQAA section when Server Vortex hubs are absent',
      async () => {
        // Default beforeEach is on-premise with no entitlement stubs, so both
        // hubs 404 and Vortex is not_applicable.
        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.exists(...GLOBAL_INSTRUCTIONS_PATH)).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'omits the SQAA section and still succeeds when the entitlement API returns a 5xx',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrgsLookupError(HTTP_SERVICE_UNAVAILABLE)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

        const result = await harness.run('integrate copilot --non-interactive', {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        });

        // Command must not abort — degraded success.
        expect(result.exitCode).toBe(0);

        expect(harness.userHome.exists(...GLOBAL_INSTRUCTIONS_PATH)).toBe(false);
        expect(harness.userHome.exists(...GLOBAL_PROMPT_HOOK_SCRIPT_PATH)).toBe(true);
      },
      { timeout: 30000 },
    );
  });

  // ─── Interactive feature selection ──────────────────────────────────────────
  //
  // Without --non-interactive each feature is gated by a prompt or an automatic skip.
  // `accept()` takes the default Yes; `decline()` answers No.

  describe('interactive feature selection', () => {
    it(
      'removes only the prompt hook when that installed feature is declined',
      async () => {
        await harness.run('integrate copilot --non-interactive');
        harness.state().withRawState(harness.stateJsonFile.asText());
        const session = harness.runInteractive('integrate copilot');
        await chooseCustomize(session);
        await session.accept('pre-tool-use hook (currently installed)  Keep?');
        await session.decline('prompt-secrets hook (currently installed)  Keep?');
        await session.accept('Proceed with removal?');
        await session.accept('MCP server (currently installed)  Keep?');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(findCopilotFeature(harness, 'prompt-secrets-hook')).toBeUndefined();
        expect(harness.userHome.exists(...GLOBAL_PROMPT_HOOK_SCRIPT_PATH)).toBe(false);
        expect(harness.userHome.exists(...GLOBAL_HOOK_SCRIPT_PATH)).toBe(true);
        const hooks = harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        expect(hooks.hooks.preToolUse).toHaveLength(1);
        expect(hooks.hooks.userPromptTransformed ?? []).toHaveLength(0);
      },
      { timeout: 60000 },
    );

    it(
      'prompts per feature, installs accepted features, and shows the Vortex promotion when not entitled',
      async () => {
        // Default beforeEach is on-premise with no entitlement stubs, so Vortex
        // is not_applicable. The three remaining
        // features (hook, prompt-secrets, MCP) each ask.
        const session = harness.runInteractive('integrate copilot');
        await chooseCustomize(session);
        await session.accept('Install pre-tool-use hook?');
        await session.accept('Install prompt-secrets hook?');
        await session.accept('Install MCP server?');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        const output = result.stdout + result.stderr;
        // Each opted feature surfaced its confirm prompt.
        expect(output).toContain('Install pre-tool-use hook?');
        expect(output).toContain('Install prompt-secrets hook?');
        expect(output).toContain('Install MCP server?');
        expect(output).toContain('Vortex requires SonarQube Server 2026.5 Enterprise or later.');
        // Accepted features are installed on disk.
        expect(harness.userHome.file(...GLOBAL_HOOK_SCRIPT_PATH).exists()).toBe(true);
        expect(harness.userHome.exists(...GLOBAL_PROMPT_HOOK_SCRIPT_PATH)).toBe(true);
        expect(harness.userHome.exists('.copilot', 'mcp-config.json')).toBe(true);
        expect(harness.userHome.exists(...GLOBAL_INSTRUCTIONS_PATH)).toBe(false);
        // Declarative state records only the accepted features.
        expect(findCopilotFeature(harness, 'pre-tool-use-hook')).toBeDefined();
        expect(findCopilotFeature(harness, 'prompt-secrets-hook')).toBeDefined();
        expect(findCopilotFeature(harness, 'mcp-server')).toBeDefined();
        expect(findCopilotFeature(harness, 'vortex')).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it.each([
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ])(
      'prints a non-interactive hint only for a detected AI agent without --non-interactive (isAgent=%s, isInteractive=%s, expectedShownPrompt=%s)',
      async (isAgent, isInteractive, expectedShownPrompt) => {
        const extraEnv: Record<string, string> = isAgent ? { COPILOT_CLI: '1' } : {};
        let result: CliResult;
        if (isInteractive) {
          const session = harness.runInteractive('integrate copilot', { extraEnv });
          await chooseCustomize(session);
          await session.accept('Install pre-tool-use hook?');
          await session.accept('Install prompt-secrets hook?');
          await session.accept('Install MCP server?');
          result = await session.waitFinish();
        } else {
          result = await harness.run('integrate copilot --non-interactive', { extraEnv });
        }

        expect(result.exitCode).toBe(0);
        if (expectedShownPrompt) {
          expectAgentPromptHint(result.stdout, 'sonar integrate copilot --non-interactive');
          expect(result.stdout).not.toContain('sonar integrate copilot-cli');
        } else {
          expectNoAgentPromptHint(result.stdout);
        }
      },
      { timeout: 30000 },
    );

    it(
      'skips a feature when the user declines its prompt',
      async () => {
        const session = harness.runInteractive('integrate copilot');
        await chooseCustomize(session);
        await session.decline('Install pre-tool-use hook?');
        await session.accept('Install prompt-secrets hook?');
        await session.accept('Install MCP server?');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.exists(...GLOBAL_HOOK_SCRIPT_PATH)).toBe(false);
        expect(findCopilotFeature(harness, 'pre-tool-use-hook')).toBeUndefined();
        // The accepted features are still installed.
        expect(harness.userHome.exists(...GLOBAL_PROMPT_HOOK_SCRIPT_PATH)).toBe(true);
        const hooks = harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        expect(hooks.hooks.preToolUse ?? []).toHaveLength(0);
        expect(hooks.hooks.userPromptTransformed).toHaveLength(1);
        expect(harness.userHome.exists('.copilot', 'mcp-config.json')).toBe(true);
        expect(findCopilotFeature(harness, 'prompt-secrets-hook')).toBeDefined();
        expect(findCopilotFeature(harness, 'mcp-server')).toBeDefined();
      },
      { timeout: 30000 },
    );
  });

  // ─── Auth gate ──────────────────────────────────────────────────────────────

  describe('auth gate', () => {
    it(
      'exits with code 1 and prompts to authenticate when no auth is configured',
      async () => {
        // Undo the auth set up by the outer beforeEach to exercise the
        // unauthenticated path.
        harness.clearAuth();

        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('❌ Not authenticated.');
        expect(output).toContain("  → Run 'sonar auth login' to authenticate.");
      },
      { timeout: 15000 },
    );
  });

  describe('-g/--global (deprecated no-op)', () => {
    it('documents --global as deprecated in --help', async () => {
      const result = await harness.run('integrate copilot --help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('--project');
      expect(result.stdout).toContain('--global');
      expect(result.stdout).toContain('[DEPRECATED]');
    });

    it('warns that --global is deprecated but still completes the (already global) install', async () => {
      const result = await harness.run('integrate copilot --non-interactive --global');

      expect(result.stderr).toContain(
        "'--global' is deprecated since 1.9.0 and will be removed in a future version. Use 'sonar integrate copilot' instead.",
      );
      expect(result.exitCode).toBe(0);
    });
  });
});
