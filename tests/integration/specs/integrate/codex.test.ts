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

// Integration tests for `sonar integrate codex`.
// The codex-prompt-submit hook handler is exhaustively covered by
// hook-agent-prompt-submit.test.ts; this spec only exercises the integrate
// command — script + hooks.json layout and idempotency. `sonar integrate
// codex` always installs globally under `~/.codex/` — there is no
// project-scoped install mode and no `-p` flag. `-g`/`--global` is accepted
// only as a deprecated no-op for backwards compatibility.

import { cpSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { parse as parseToml } from 'smol-toml';

import { CONTEXT_AUGMENTATION_FEATURE_ID } from '../../../../src/commands/integrate/_common/features/context-augmentation-feature';
import {
  SQAA_HOOK_FEATURE_ID,
  SQAA_INSTRUCTIONS_SUBFEATURE_ID,
} from '../../../../src/commands/integrate/_common/features/sqaa-instructions-feature';
import { VORTEX_FEATURE_ID } from '../../../../src/commands/integrate/_common/vortex';
import { ENV_SONAR_USER_HOME } from '../../../../src/core/config-constants.ts';
import {
  expectAgentPromptHint,
  expectNoAgentPromptHint,
} from '../../../_common/agent-hint-assertions.js';
import {
  type CliResult,
  hookScriptName,
  hookScriptPath,
  normalizePath,
  TestHarness,
} from '../../harness';
import { findInstalledFeature, findInstalledSubfeature } from './state-helpers';

const PROMPT_SCRIPT_DIRS = ['.codex', 'hooks', 'sonar-secrets', 'build-scripts'];
const SQAA_SCRIPT_DIRS = ['.codex', 'hooks', 'sonar-sqaa', 'build-scripts'];
const HOOKS_JSON_DIRS = ['.codex', 'hooks.json'];
// Codex reads project guidance from `AGENTS.md` at the repository root, and
// global guidance from `~/.codex/AGENTS.md`.
const PROJECT_AGENTS_MD_DIRS = ['AGENTS.md'];
const GLOBAL_AGENTS_MD_DIRS = ['.codex', 'AGENTS.md'];
const CONFIG_TOML_DIRS = ['.codex', 'config.toml'];
const SECRETS_HEADING = '# SonarQube secrets scanning for files protocol';
const SQAA_HEADING = '# Vortex analysis protocol';

interface CodexHooksFile {
  hooks?: {
    UserPromptSubmit?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
    }>;
    PostToolUse?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
    }>;
  };
}

function findCodexFeature(harness: TestHarness, featureId: string, scope?: string) {
  return findInstalledFeature(harness, 'codex', featureId, scope);
}

describe('integrate codex', () => {
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

  describe('install (default: global)', () => {
    it(
      'writes script + hooks.json under $HOME/.codex/ with an absolute command path',
      async () => {
        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('.codex')).toBe(false);

        const scriptFile = harness.userHome.file(
          ...PROMPT_SCRIPT_DIRS,
          hookScriptName('prompt-secrets'),
        );
        expect(scriptFile.exists()).toBe(true);
        expect(scriptFile.isExecutable).toBe(true);
        expect(scriptFile.asText()).toContain('sonar hook codex-prompt-submit');

        const hooks: CodexHooksFile = harness.userHome.file(...HOOKS_JSON_DIRS).asJson();
        const entry = hooks.hooks?.UserPromptSubmit?.[0];
        expect(entry?.matcher).toBe('*');
        expect(entry?.hooks?.[0]?.type).toBe('command');
        expect(entry?.hooks?.[0]?.command).toContain('sonar-secrets');
        const command = hookScriptPath(String(entry?.hooks?.[0]?.command));
        expect(isAbsolute(command)).toBe(true);
        expect(command.startsWith(normalizePath(harness.userHome.path))).toBe(true);

        // Completion summary
        expect(result.stdout).toContain('Installed');
        expect(result.stdout).toContain('Setup complete!');
        expect(result.stdout).toContain('paste this into Codex');
      },
      { timeout: 30000 },
    );

    it(
      're-running does not duplicate the UserPromptSubmit entry',
      async () => {
        await harness.run('integrate codex --non-interactive');
        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        const hooks: CodexHooksFile = harness.userHome.file(...HOOKS_JSON_DIRS).asJson();
        expect(hooks.hooks?.UserPromptSubmit).toHaveLength(1);
      },
      { timeout: 30000 },
    );

    it(
      'preserves pre-existing non-Sonar entries in hooks.json across re-install',
      async () => {
        harness.userHome.writeFile(
          '.codex/hooks.json',
          JSON.stringify({
            hooks: {
              UserPromptSubmit: [
                {
                  matcher: '*',
                  hooks: [
                    { type: 'command', command: '.codex/hooks/other-tool/run.sh', timeout: 30 },
                  ],
                },
              ],
            },
          }),
        );

        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        const hooks: CodexHooksFile = harness.userHome.file(...HOOKS_JSON_DIRS).asJson();
        const commands = hooks.hooks?.UserPromptSubmit?.flatMap(
          (entry) => entry.hooks?.map((hook) => hook.command) ?? [],
        );
        expect(commands?.some((command) => command?.includes('other-tool'))).toBe(true);
        expect(commands?.some((command) => command?.includes('sonar-secrets'))).toBe(true);
      },
      { timeout: 30000 },
    );
  });

  describe('MCP server config', () => {
    it(
      'writes [mcp_servers.sonarqube] to $HOME/.codex/config.toml, project-agnostic even when a key is discovered',
      async () => {
        // A global config is shared across every project on the machine, so
        // it never bakes in a --project arg, even when one is discoverable.
        harness.cwd.writeFile('sonar-project.properties', 'sonar.projectKey=my-project\n');

        const result = await harness.run('integrate codex --non-interactive');

        // Assert on the result and the file contents
        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...CONFIG_TOML_DIRS)).toBe(false);
        expect(harness.userHome.exists(...CONFIG_TOML_DIRS)).toBe(true);
        const tomlBody = harness.userHome.file(...CONFIG_TOML_DIRS).asText();
        expect(tomlBody).toContain('[mcp_servers.sonarqube]');
        expect(tomlBody).toContain('run');
        expect(tomlBody).toContain('mcp');
        expect(tomlBody).not.toContain('--project');
        expect(tomlBody).not.toContain('[mcp_servers.sonarqube.env]');

        // Assert on the state
        const state = harness.stateJsonFile.asJson();
        const codex = state.integrations.installed.find(
          (entry: { integrationId: string }) => entry.integrationId === 'codex',
        );
        const mcpFeature = codex?.features?.find(
          (feature: { featureId: string }) => feature.featureId === 'mcp-server',
        );
        expect(mcpFeature).toMatchObject({
          resources: [
            {
              id: 'mcp-config',
              resourceType: 'toml-patch',
              path: harness.userHome.file(...CONFIG_TOML_DIRS).path,
            },
          ],
        });
      },
      { timeout: 30000 },
    );

    it(
      'forwards SONAR_USER_HOME into [mcp_servers.sonarqube.env] and refreshes a prior entry',
      async () => {
        const first = await harness.run('integrate codex --non-interactive');
        expect(first.exitCode).toBe(0);
        expect(harness.userHome.file(...CONFIG_TOML_DIRS).asText()).not.toContain(
          '[mcp_servers.sonarqube.env]',
        );

        // Distinct from $HOME/.sonar. Copy cliHome because harness.run() always
        // writes state there, and the child with a custom home must still find auth.
        const customHome = join(harness.userHome.path, 'custom-sonar');
        cpSync(harness.cliHome.path, join(customHome, 'sonarqube-cli'), { recursive: true });
        const result = await harness.run('integrate codex --non-interactive', {
          extraEnv: { [ENV_SONAR_USER_HOME]: customHome },
        });

        expect(result.exitCode).toBe(0);
        const tomlBody = harness.userHome.file(...CONFIG_TOML_DIRS).asText();
        expect(tomlBody).toContain('[mcp_servers.sonarqube.env]');
        const parsed = parseToml(tomlBody) as {
          mcp_servers?: { sonarqube?: { env?: Record<string, string> } };
        };
        expect(parsed.mcp_servers?.sonarqube?.env?.[ENV_SONAR_USER_HOME]).toBe(customHome);
      },
      { timeout: 30000 },
    );

    it(
      're-running does not change the config.toml or duplicate [mcp_servers.sonarqube]',
      async () => {
        await harness.run('integrate codex --non-interactive');
        const firstBody = harness.userHome.file(...CONFIG_TOML_DIRS).asText();

        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.file(...CONFIG_TOML_DIRS).asText()).toBe(firstBody);
      },
      { timeout: 30000 },
    );

    it(
      'overwrites an existing [mcp_servers.sonarqube] entry with the canonical config',
      async () => {
        harness.userHome.writeFile(
          '.codex/config.toml',
          '[mcp_servers.sonarqube]\ncommand = "custom-sonar"\nargs = ["custom", "args"]\n',
        );

        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        const body = harness.userHome.file(...CONFIG_TOML_DIRS).asText();
        expect(body).not.toContain('custom-sonar');
        expect(body).toContain('[mcp_servers.sonarqube]');
        expect(body).toContain('"run"');
        expect(body).toContain('"mcp"');
      },
      { timeout: 30000 },
    );

    it(
      'fails when the existing config.toml contains invalid TOML',
      async () => {
        harness.userHome.writeFile('.codex/config.toml', '= not valid toml =');

        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(1);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).toContain('config.toml contains invalid TOML');
        expect(output).toContain('Please fix or delete it and re-run.');
      },
      { timeout: 30000 },
    );

    it(
      'omits --project from the args array when no project key is known',
      async () => {
        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        const tomlBody = harness.userHome.file(...CONFIG_TOML_DIRS).asText();
        expect(tomlBody).toContain('[mcp_servers.sonarqube]');
        expect(tomlBody).not.toContain('--project');
      },
      { timeout: 30000 },
    );

    it(
      'merges the sonarqube entry alongside pre-existing Codex config without touching unrelated tables',
      async () => {
        harness.userHome.writeFile(
          '.codex/config.toml',
          [
            'model = "gpt-5.3-codex"',
            'model_reasoning_effort = "medium"',
            '',
            '[plugins."browser-use@openai-bundled"]',
            'enabled = true',
            '',
            '[mcp_servers.other]',
            'command = "other"',
            'args = ["go"]',
            '',
          ].join('\n'),
        );

        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        const tomlBody = harness.userHome.file(...CONFIG_TOML_DIRS).asText();
        expect(tomlBody).toContain('model = "gpt-5.3-codex"');
        expect(tomlBody).toContain('model_reasoning_effort = "medium"');
        expect(tomlBody).toContain('[plugins."browser-use@openai-bundled"]');
        expect(tomlBody).toContain('[mcp_servers.other]');
        expect(tomlBody).toContain('[mcp_servers.sonarqube]');
      },
      { timeout: 30000 },
    );
  });

  describe('AGENTS.md instructions', () => {
    const TEST_ORG = 'my-org';
    const TEST_PROJECT = 'my-project';

    it(
      'writes ~/.codex/AGENTS.md (and nothing project-side), showing the Vortex promotion when not entitled',
      async () => {
        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...PROJECT_AGENTS_MD_DIRS)).toBe(false);
        const body = harness.userHome.file(...GLOBAL_AGENTS_MD_DIRS).asText();

        expect(body).toContain('<!-- sonar:begin:codex-secrets-on-read -->');
        expect(body).toContain('<!-- sonar:end:codex-secrets-on-read -->');
        expect(body).toContain(SECRETS_HEADING);
        expect(body).toContain('sonar analyze secrets');
        expect(body).not.toContain(SQAA_HEADING);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).toContain('Vortex requires SonarQube Server 2026.5 Enterprise or later.');
      },
      { timeout: 30000 },
    );

    it(
      'installs PostToolUse SQAA hook on apply_patch and writes the AGENTS.md SQAA protocol when Vortex entitled',
      async () => {
        harness.state().withContextAugmentationBinaryInstalled();
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
          .withVortexEntitlement(TEST_ORG, 'test-uuid-1234')
          .withProject(TEST_PROJECT)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

        const result = await harness.run('integrate codex --non-interactive', {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        const body = harness.userHome.file(...GLOBAL_AGENTS_MD_DIRS).asText();
        expect(body).toContain('<!-- sonar:begin:codex-secrets-on-read -->');
        expect(body).toContain('<!-- sonar:begin:sonarqube-agentic-analysis-protocol -->');
        expect(body).toContain(SQAA_HEADING);
        expect(body).toContain('sonar analyze agentic --depth DEEP');
        expect(
          findInstalledSubfeature(
            harness,
            'codex',
            VORTEX_FEATURE_ID,
            SQAA_INSTRUCTIONS_SUBFEATURE_ID,
          ),
        ).toBeDefined();

        const sqaaScript = harness.userHome.file(
          ...SQAA_SCRIPT_DIRS,
          hookScriptName('posttool-sqaa'),
        );
        expect(sqaaScript.exists()).toBe(true);
        expect(sqaaScript.isExecutable).toBe(true);
        expect(sqaaScript.asText()).toContain('sonar hook codex-post-tool-use');
        // The handler resolves the project at run time, so the key is not baked in.
        expect(sqaaScript.asText()).not.toContain('--project');

        const hooks: CodexHooksFile = harness.userHome.file(...HOOKS_JSON_DIRS).asJson();
        const postTool = hooks.hooks?.PostToolUse?.find((e) =>
          e.hooks?.some((h) => h.command?.includes('sonar-sqaa')),
        );
        expect(postTool?.matcher).toBe('apply_patch');
        expect(postTool?.hooks?.[0]?.command).toContain('sonar-sqaa');
        expect(harness.cwd.exists(...SQAA_SCRIPT_DIRS)).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'writes SQAA into the global AGENTS.md when a project key is discovered from sonar-project.properties',
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
        harness.cwd.writeFile('sonar-project.properties', `sonar.projectKey=${TEST_PROJECT}\n`);

        const result = await harness.run('integrate codex --non-interactive', {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...PROJECT_AGENTS_MD_DIRS)).toBe(false);

        const globalBody = harness.userHome.file(...GLOBAL_AGENTS_MD_DIRS).asText();
        expect(globalBody).toContain(SECRETS_HEADING);
        expect(globalBody).toContain(SQAA_HEADING);

        const sqaaScript = harness.userHome.file(
          ...SQAA_SCRIPT_DIRS,
          hookScriptName('posttool-sqaa'),
        );
        expect(sqaaScript.exists()).toBe(true);
        expect(sqaaScript.asText()).toContain('sonar hook codex-post-tool-use');
        const hooks: CodexHooksFile = harness.userHome.file(...HOOKS_JSON_DIRS).asJson();
        expect(
          hooks.hooks?.PostToolUse?.find((e) =>
            e.hooks?.some((h) => h.command?.includes('sonar-sqaa')),
          )?.matcher,
        ).toBe('apply_patch');
      },
      { timeout: 30000 },
    );

    it(
      'does not install PostToolUse SQAA hook when the org has no Vortex entitlement',
      async () => {
        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        const hooks: CodexHooksFile = harness.userHome.file(...HOOKS_JSON_DIRS).asJson();
        expect(hooks.hooks?.PostToolUse).toBeUndefined();
        const body = harness.userHome.file(...GLOBAL_AGENTS_MD_DIRS).asText();
        expect(body).not.toContain('sonarqube-agentic-analysis-protocol');
      },
      { timeout: 30000 },
    );

    it(
      're-running does not duplicate the PostToolUse SQAA entry when Vortex entitled',
      async () => {
        harness.state().withContextAugmentationBinaryInstalled();
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
          .withVortexEntitlement(TEST_ORG, 'test-uuid-1234')
          .withProject(TEST_PROJECT)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

        const extraEnv = {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        };
        await harness.run('integrate codex --non-interactive', { extraEnv });
        const result = await harness.run('integrate codex --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        const hooks: CodexHooksFile = harness.userHome.file(...HOOKS_JSON_DIRS).asJson();
        const sqaaEntries = hooks.hooks?.PostToolUse?.filter((e) =>
          e.hooks?.some((h) => h.command?.includes('sonar-sqaa')),
        );
        expect(sqaaEntries).toHaveLength(1);
      },
      { timeout: 30000 },
    );

    it(
      'preserves pre-existing non-Sonar PostToolUse entries when adding SQAA hook',
      async () => {
        harness.state().withContextAugmentationBinaryInstalled();
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
          .withVortexEntitlement(TEST_ORG, 'test-uuid-1234')
          .withProject(TEST_PROJECT)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

        harness.userHome.writeFile(
          '.codex/hooks.json',
          JSON.stringify({
            hooks: {
              PostToolUse: [
                {
                  matcher: 'other_tool',
                  hooks: [
                    { type: 'command', command: '.codex/hooks/other-tool/run.sh', timeout: 30 },
                  ],
                },
              ],
            },
          }),
        );

        const result = await harness.run('integrate codex --non-interactive', {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        const hooks: CodexHooksFile = harness.userHome.file(...HOOKS_JSON_DIRS).asJson();
        const commands = hooks.hooks?.PostToolUse?.flatMap(
          (entry) => entry.hooks?.map((hook) => hook.command) ?? [],
        );
        expect(commands?.some((command) => command?.includes('other-tool'))).toBe(true);
        expect(commands?.some((command) => command?.includes('sonar-sqaa'))).toBe(true);
      },
      { timeout: 30000 },
    );
  });

  describe('interactive feature selection', () => {
    it(
      'prompts per feature, installs accepted features, and shows the Vortex promotion when not entitled',
      async () => {
        // Default beforeEach is on-premise with no entitlement stubs, so Vortex
        // is not_applicable. The three remaining features
        // (secrets hook, secrets instructions, MCP) each ask.
        const session = harness.runInteractive('integrate codex');
        await session.accept('Install secret scanning hooks?');
        await session.accept('Install secrets-on-read instructions?');
        await session.accept('Install MCP server?');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        const output = `${result.stdout}\n${result.stderr}`;
        // Each opted feature surfaced its confirm prompt.
        expect(output).toContain('Install secret scanning hooks?');
        expect(output).toContain('Install secrets-on-read instructions?');
        expect(output).toContain('Install MCP server?');
        expect(output).not.toContain('Install Vortex?');
        expect(output).toContain('Vortex requires SonarQube Server 2026.5 Enterprise or later.');
        // Accepted features are installed on disk.
        expect(
          harness.userHome.file(...PROMPT_SCRIPT_DIRS, hookScriptName('prompt-secrets')).exists(),
        ).toBe(true);
        expect(harness.userHome.exists(...HOOKS_JSON_DIRS)).toBe(true);
        const agentsMd = harness.userHome.file(...GLOBAL_AGENTS_MD_DIRS).asText();
        expect(agentsMd).toContain(SECRETS_HEADING);
        // No SQAA marker block was written (Server hubs absent).
        expect(agentsMd).not.toContain(SQAA_HEADING);
        expect(harness.userHome.exists(...CONFIG_TOML_DIRS)).toBe(true);
        // Declarative state records only the accepted features.
        expect(findCodexFeature(harness, 'sonar-secrets-hooks')).toBeDefined();
        expect(findCodexFeature(harness, 'secrets-instructions')).toBeDefined();
        expect(findCodexFeature(harness, 'mcp-server')).toBeDefined();
        expect(findCodexFeature(harness, VORTEX_FEATURE_ID)).toBeUndefined();
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
        const extraEnv: Record<string, string> = isAgent
          ? { CODEX_SANDBOX_NETWORK_DISABLED: '1' }
          : {};
        let result: CliResult;
        if (isInteractive) {
          const session = harness.runInteractive('integrate codex', { extraEnv });
          await session.accept('Install secret scanning hooks?');
          await session.accept('Install secrets-on-read instructions?');
          await session.accept('Install MCP server?');
          result = await session.waitFinish();
        } else {
          result = await harness.run('integrate codex --non-interactive', { extraEnv });
        }

        expect(result.exitCode).toBe(0);
        if (expectedShownPrompt) {
          expectAgentPromptHint(result.stdout, 'sonar integrate codex --non-interactive');
        } else {
          expectNoAgentPromptHint(result.stdout);
        }
      },
      { timeout: 30000 },
    );

    it(
      'skips a feature when the user declines its prompt',
      async () => {
        const session = harness.runInteractive('integrate codex');
        await session.decline('Install secret scanning hooks?');
        await session.accept('Install secrets-on-read instructions?');
        await session.accept('Install MCP server?');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        // Hook was declined: no hook artifacts and no state entry.
        expect(harness.userHome.exists('.codex', 'hooks')).toBe(false);
        expect(harness.userHome.exists(...HOOKS_JSON_DIRS)).toBe(false);
        expect(findCodexFeature(harness, 'sonar-secrets-hooks')).toBeUndefined();
        // The accepted features are still installed.
        expect(harness.userHome.file(...GLOBAL_AGENTS_MD_DIRS).asText()).toContain(SECRETS_HEADING);
        expect(harness.userHome.exists(...CONFIG_TOML_DIRS)).toBe(true);
        expect(findCodexFeature(harness, 'secrets-instructions')).toBeDefined();
        expect(findCodexFeature(harness, 'mcp-server')).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'asks before installing Vortex when the org is entitled and a project key is known',
      async () => {
        const testOrg = 'my-org';
        const testProject = 'my-project';
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: testOrg, name: 'My Org' }])
          .withVortexEntitlement(testOrg, 'test-uuid-1234')
          .withProject(testProject)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', testOrg);

        const session = harness.runInteractive('integrate codex', {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
            __SQCLI_DEV_SKIP_CAG: '1',
          },
        });
        await session.accept('Install secret scanning hooks?');
        await session.accept('Install Vortex?');
        await session.accept('Install secrets-on-read instructions?');
        await session.accept('Install MCP server?');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).toContain('Install Vortex?');
        expect(
          harness.userHome.file(...SQAA_SCRIPT_DIRS, hookScriptName('posttool-sqaa')).exists(),
        ).toBe(true);
        expect(
          findInstalledSubfeature(harness, 'codex', VORTEX_FEATURE_ID, SQAA_HOOK_FEATURE_ID),
        ).toBeDefined();
        expect(
          findInstalledSubfeature(
            harness,
            'codex',
            VORTEX_FEATURE_ID,
            CONTEXT_AUGMENTATION_FEATURE_ID,
          ),
        ).toBeUndefined();
      },
      { timeout: 30000 },
    );
  });

  describe('-g/--global (deprecated no-op)', () => {
    it('documents --global as deprecated in --help', async () => {
      const result = await harness.run('integrate codex --help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('--project');
      expect(result.stdout).toContain('--global');
      expect(result.stdout).toContain('[DEPRECATED]');
    });

    it('warns that --global is deprecated but still completes the (already global) install', async () => {
      const result = await harness.run('integrate codex --non-interactive --global');

      expect(result.stderr).toContain(
        "'--global' is deprecated since 1.9.0 and will be removed in a future version. Use 'sonar integrate codex' instead.",
      );
      expect(result.exitCode).toBe(0);
    });
  });
});
