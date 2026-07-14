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
// command — script + hooks.json layout, scope semantics, and idempotency.

import { isAbsolute } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { codexIntegration } from '../../../../src/cli/commands/integrate/codex/declaration';
import {
  expectAgentPromptHint,
  expectNoAgentPromptHint,
} from '../../../_common/agent-hint-assertions.js';
import {
  hookScriptName,
  hookScriptPath,
  IS_WINDOWS,
  normalizePath,
  TestHarness,
} from '../../harness';
import { findInstalledFeature } from './state-helpers';

const PROMPT_SCRIPT_DIRS = ['.codex', 'hooks', 'sonar-secrets', 'build-scripts'];
const SQAA_SCRIPT_DIRS = ['.codex', 'hooks', 'sonar-sqaa', 'build-scripts'];
const HOOKS_JSON_DIRS = ['.codex', 'hooks.json'];
// Codex reads project guidance from `AGENTS.md` at the repository root, and
// global guidance from `~/.codex/AGENTS.md`.
const PROJECT_AGENTS_MD_DIRS = ['AGENTS.md'];
const GLOBAL_AGENTS_MD_DIRS = ['.codex', 'AGENTS.md'];
const CONFIG_TOML_DIRS = ['.codex', 'config.toml'];
const SECRETS_HEADING = '# SonarQube secrets scanning for files protocol';
const SQAA_HEADING = '# SonarQube Agentic Analysis protocol';

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

  describe('project-level install (default)', () => {
    it(
      'writes an executable prompt-submit script and a hooks.json entry under .codex/',
      async () => {
        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);

        const scriptFile = harness.cwd.file(
          ...PROMPT_SCRIPT_DIRS,
          hookScriptName('prompt-secrets'),
        );
        expect(scriptFile.exists()).toBe(true);
        expect(scriptFile.isExecutable).toBe(true);

        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const entry = hooks.hooks?.UserPromptSubmit?.[0];
        expect(entry?.matcher).toBe('*');
        expect(entry?.hooks?.[0]?.type).toBe('command');
        expect(entry?.hooks?.[0]?.command).toContain('sonar-secrets');

        // Completion summary
        expect(result.stdout).toContain('Installed');
        expect(result.stdout).toContain('Setup complete!');
        expect(result.stdout).toContain('paste this into Codex');
      },
      { timeout: 30000 },
    );

    it(
      'uses a project-relative command path so the config is portable',
      async () => {
        await harness.run('integrate codex --non-interactive');

        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const command = hookScriptPath(
          String(hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command),
        );
        expect(isAbsolute(command)).toBe(false);
        expect(command.startsWith('.codex/')).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'quotes the hook command so it survives a project directory containing a space',
      async () => {
        const spacedDir = harness.cwd.dir('dir with space', 'myproj');
        spacedDir.writeFile('sonar-project.properties', 'sonar.projectKey=my-project');

        const result = await harness.run('integrate codex --non-interactive', {
          cwd: spacedDir.path,
        });

        expect(result.exitCode).toBe(0);
        const hooks: CodexHooksFile = spacedDir.file(...HOOKS_JSON_DIRS).asJson();
        const command = String(hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command);
        // Project scope emits a relative, fully-quoted path (double quotes on
        // Windows, single quotes on Unix) — deterministic regardless of the
        // spaced project directory, so assert the exact command.
        const scriptRel = '.codex/hooks/sonar-secrets/build-scripts/prompt-secrets';
        expect(command).toBe(
          IS_WINDOWS
            ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptRel}.ps1"`
            : `'${scriptRel}.sh'`,
        );
      },
      { timeout: 30000 },
    );

    it(
      're-running does not duplicate the UserPromptSubmit entry',
      async () => {
        await harness.run('integrate codex --non-interactive');
        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        expect(hooks.hooks?.UserPromptSubmit).toHaveLength(1);
      },
      { timeout: 30000 },
    );

    it(
      'preserves pre-existing non-Sonar entries in hooks.json across re-install',
      async () => {
        harness.cwd.writeFile(
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
        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const commands = hooks.hooks?.UserPromptSubmit?.flatMap(
          (entry) => entry.hooks?.map((hook) => hook.command) ?? [],
        );
        expect(commands?.some((command) => command?.includes('other-tool'))).toBe(true);
        expect(commands?.some((command) => command?.includes('sonar-secrets'))).toBe(true);
      },
      { timeout: 30000 },
    );
  });

  describe('global install (-g)', () => {
    it(
      'writes script + hooks.json under $HOME/.codex/ with an absolute command path',
      async () => {
        const result = await harness.run('integrate codex -g --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('.codex')).toBe(false);

        expect(
          harness.userHome.exists(...PROMPT_SCRIPT_DIRS, hookScriptName('prompt-secrets')),
        ).toBe(true);

        const hooks: CodexHooksFile = harness.userHome.file(...HOOKS_JSON_DIRS).asJson();
        const command = hookScriptPath(
          String(hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command),
        );
        expect(isAbsolute(command)).toBe(true);
        expect(command.startsWith(normalizePath(harness.userHome.path))).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'skips the project-level secrets hook when a global Codex hook is already recorded',
      async () => {
        // Seed a previously-installed global secrets hook so the state probe
        // (isFeatureInstalledGloballyForProject) fires for the project run.
        harness
          .state()
          .withInstalledIntegrationFeature(codexIntegration, 'sonar-secrets-hooks', 'global');

        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
          'A global secrets scanning hook is already configured. Skipping project-level secrets hooks to avoid duplicate execution.',
        );
        // No project-level hook artifacts were written.
        expect(harness.cwd.exists('.codex', 'hooks')).toBe(false);
        expect(harness.cwd.exists(...HOOKS_JSON_DIRS)).toBe(false);
        expect(findCodexFeature(harness, 'sonar-secrets-hooks', 'project')).toBeUndefined();
        // The remaining project features still install.
        expect(harness.cwd.file(...PROJECT_AGENTS_MD_DIRS).asText()).toContain(SECRETS_HEADING);
        expect(harness.cwd.exists(...CONFIG_TOML_DIRS)).toBe(true);
      },
      { timeout: 30000 },
    );
  });

  describe('MCP server config', () => {
    it(
      'writes [mcp_servers.sonarqube] to .codex/config.toml at project scope',
      async () => {
        harness.cwd.writeFile('sonar-project.properties', 'sonar.projectKey=my-project\n');

        const result = await harness.run('integrate codex --non-interactive');

        // Assert on the result and the file contents
        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...CONFIG_TOML_DIRS)).toBe(true);
        const tomlBody = harness.cwd.file(...CONFIG_TOML_DIRS).asText();
        expect(tomlBody).toContain('[mcp_servers.sonarqube]');
        expect(tomlBody).toContain('run');
        expect(tomlBody).toContain('mcp');
        expect(tomlBody).toContain('--project');
        expect(tomlBody).toContain('my-project');

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
              id: 'codex-mcp-config',
              resourceType: 'toml-patch',
              path: harness.cwd.file(...CONFIG_TOML_DIRS).path,
            },
          ],
        });
      },
      { timeout: 30000 },
    );

    it(
      'writes the MCP config to $HOME/.codex/config.toml for global installs',
      async () => {
        const result = await harness.run('integrate codex -g --non-interactive');

        // Assert on the result and the file contents
        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...CONFIG_TOML_DIRS)).toBe(false);
        expect(harness.userHome.exists(...CONFIG_TOML_DIRS)).toBe(true);
        const tomlBody = harness.userHome.file(...CONFIG_TOML_DIRS).asText();
        expect(tomlBody).toContain('[mcp_servers.sonarqube]');
        expect(tomlBody).toContain('run');
        expect(tomlBody).toContain('mcp');

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
              id: 'codex-mcp-config',
              resourceType: 'toml-patch',
              path: harness.userHome.file(...CONFIG_TOML_DIRS).path,
            },
          ],
        });
      },
      { timeout: 30000 },
    );

    it(
      're-running does not change the config.toml or duplicate [mcp_servers.sonarqube]',
      async () => {
        await harness.run('integrate codex --non-interactive');
        const firstBody = harness.cwd.file(...CONFIG_TOML_DIRS).asText();

        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.file(...CONFIG_TOML_DIRS).asText()).toBe(firstBody);
      },
      { timeout: 30000 },
    );

    it(
      'overwrites an existing [mcp_servers.sonarqube] entry with the canonical config',
      async () => {
        harness.cwd.writeFile('sonar-project.properties', 'sonar.projectKey=my-project\n');
        harness.cwd.writeFile(
          '.codex/config.toml',
          '[mcp_servers.sonarqube]\ncommand = "custom-sonar"\nargs = ["custom", "args"]\n',
        );

        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        const body = harness.cwd.file(...CONFIG_TOML_DIRS).asText();
        expect(body).not.toContain('custom-sonar');
        expect(body).toContain('[mcp_servers.sonarqube]');
        expect(body).toContain('my-project');
      },
      { timeout: 30000 },
    );

    it(
      'fails when the existing config.toml contains invalid TOML',
      async () => {
        harness.cwd.writeFile('.codex/config.toml', '= not valid toml =');

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
        const tomlBody = harness.cwd.file(...CONFIG_TOML_DIRS).asText();
        expect(tomlBody).toContain('[mcp_servers.sonarqube]');
        expect(tomlBody).not.toContain('--project');
      },
      { timeout: 30000 },
    );

    it(
      'merges the sonarqube entry alongside pre-existing Codex config without touching unrelated tables',
      async () => {
        harness.cwd.writeFile(
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
        const tomlBody = harness.cwd.file(...CONFIG_TOML_DIRS).asText();
        expect(tomlBody).toContain('model = "gpt-5.3-codex"');
        expect(tomlBody).toContain('model_reasoning_effort = "medium"');
        expect(tomlBody).toContain('[plugins."browser-use@openai-bundled"]');
        expect(tomlBody).toContain('[mcp_servers.other]');
        expect(tomlBody).toContain('[mcp_servers.sonarqube]');
      },
      { timeout: 30000 },
    );
  });

  describe('option validation', () => {
    it('rejects --global combined with --project', async () => {
      const result = await harness.run('integrate codex -g -p some-project --non-interactive');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('mutually exclusive');
    });
  });

  describe('AGENTS.md instructions', () => {
    const TEST_ORG = 'my-org';
    const TEST_PROJECT = 'my-project';

    it(
      'writes the secrets-on-read section to <repo>/AGENTS.md at project scope (no SQAA without entitlement)',
      async () => {
        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        const body = harness.cwd.file(...PROJECT_AGENTS_MD_DIRS).asText();

        expect(body).toContain('<!-- sonar:begin:codex-secrets-on-read -->');
        expect(body).toContain('<!-- sonar:end:codex-secrets-on-read -->');
        expect(body).toContain(SECRETS_HEADING);
        expect(body).toContain('sonar analyze secrets');
      },
      { timeout: 30000 },
    );

    it(
      'installs PostToolUse SQAA hook on apply_patch and omits AGENTS.md SQAA protocol when entitled',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
          .withSqaaEntitlement(TEST_ORG, 'test-uuid-1234')
          .withProject(TEST_PROJECT)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

        const result = await harness.run(
          `integrate codex --project ${TEST_PROJECT} --non-interactive`,
          {
            extraEnv: {
              SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
              SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
            },
          },
        );

        expect(result.exitCode).toBe(0);
        const body = harness.cwd.file(...PROJECT_AGENTS_MD_DIRS).asText();
        expect(body).toContain('<!-- sonar:begin:codex-secrets-on-read -->');
        expect(body).not.toContain('<!-- sonar:begin:sonarqube-agentic-analysis-protocol -->');
        expect(body).not.toContain(SQAA_HEADING);
        expect(body).not.toContain('sonar analyze agentic');

        const sqaaScript = harness.cwd.file(...SQAA_SCRIPT_DIRS, hookScriptName('posttool-sqaa'));
        expect(sqaaScript.exists()).toBe(true);
        expect(sqaaScript.isExecutable).toBe(true);
        expect(sqaaScript.asText()).toContain('codex-post-tool-use');
        expect(sqaaScript.asText()).toContain(`--project '${TEST_PROJECT}'`);

        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const postTool = hooks.hooks?.PostToolUse?.find((e) =>
          e.hooks?.some((h) => h.command?.includes('sonar-sqaa')),
        );
        expect(postTool?.matcher).toBe('apply_patch');
        expect(postTool?.hooks?.[0]?.command).toContain('sonar-sqaa');
      },
      { timeout: 30000 },
    );

    it(
      'does not install PostToolUse SQAA hook when the org has no entitlement',
      async () => {
        const result = await harness.run('integrate codex --non-interactive');

        expect(result.exitCode).toBe(0);
        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        expect(hooks.hooks?.PostToolUse).toBeUndefined();
        const body = harness.cwd.file(...PROJECT_AGENTS_MD_DIRS).asText();
        expect(body).not.toContain('sonarqube-agentic-analysis-protocol');
      },
      { timeout: 30000 },
    );

    it(
      're-running does not duplicate the PostToolUse SQAA entry when entitled',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
          .withSqaaEntitlement(TEST_ORG, 'test-uuid-1234')
          .withProject(TEST_PROJECT)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

        await harness.run(`integrate codex --project ${TEST_PROJECT} --non-interactive`, {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        });
        const result = await harness.run(
          `integrate codex --project ${TEST_PROJECT} --non-interactive`,
          {
            extraEnv: {
              SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
              SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
            },
          },
        );

        expect(result.exitCode).toBe(0);
        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
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
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
          .withSqaaEntitlement(TEST_ORG, 'test-uuid-1234')
          .withProject(TEST_PROJECT)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

        harness.cwd.writeFile(
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

        const result = await harness.run(
          `integrate codex --project ${TEST_PROJECT} --non-interactive`,
          {
            extraEnv: {
              SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
              SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
            },
          },
        );

        expect(result.exitCode).toBe(0);
        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const commands = hooks.hooks?.PostToolUse?.flatMap(
          (entry) => entry.hooks?.map((hook) => hook.command) ?? [],
        );
        expect(commands?.some((command) => command?.includes('other-tool'))).toBe(true);
        expect(commands?.some((command) => command?.includes('sonar-sqaa'))).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'writes ~/.codex/AGENTS.md (and nothing project-side) at global scope without SQAA entitlement, showing the promotion',
      async () => {
        const result = await harness.run('integrate codex -g --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...PROJECT_AGENTS_MD_DIRS)).toBe(false);
        const body = harness.userHome.file(...GLOBAL_AGENTS_MD_DIRS).asText();
        expect(body).toContain(SECRETS_HEADING);
        expect(body).not.toContain(SQAA_HEADING);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).toContain('Vortex agentic analysis is available on SonarQube Cloud');
      },
      { timeout: 30000 },
    );

    it(
      'on global install, does not write SQAA project-side but warns it is not supported with --global when the org is entitled',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
          .withSqaaEntitlement(TEST_ORG, 'test-uuid-1234')
          .withProject(TEST_PROJECT)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);
        harness.cwd.writeFile('sonar-project.properties', `sonar.projectKey=${TEST_PROJECT}\n`);

        const result = await harness.run('integrate codex -g --non-interactive', {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...PROJECT_AGENTS_MD_DIRS)).toBe(false);

        const globalBody = harness.userHome.file(...GLOBAL_AGENTS_MD_DIRS).asText();
        expect(globalBody).toContain(SECRETS_HEADING);
        expect(globalBody).not.toContain(SQAA_HEADING);

        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).toContain('Skipping Vortex agentic analysis');
        expect(output).toContain('not supported with --global');
      },
      { timeout: 30000 },
    );
  });

  describe('interactive feature selection', () => {
    it(
      'prompts per feature, installs accepted features, and shows the SQAA promotion when not entitled',
      async () => {
        // Default beforeEach is on-premise auth with no org, so SQAA and
        // Context Augmentation are not available. The three remaining features
        // (secrets hook, secrets instructions, MCP) each ask. The leading '\r'
        // selects project scope before the per-feature prompts.
        const result = await harness.run('integrate codex', {
          stdinChunks: ['\r', '\r', '\r', '\r'],
        });

        expect(result.exitCode).toBe(0);
        const output = `${result.stdout}\n${result.stderr}`;
        // Each opted feature surfaced its confirm prompt.
        expect(output).toContain('Install secret scanning hooks?');
        expect(output).toContain('Install secrets-on-read instructions?');
        expect(output).toContain('Install MCP server?');
        // SQAA is not eligible, so it is skipped without a prompt but the shared
        // promotion message is surfaced.
        expect(output).not.toContain('Install Vortex agentic analysis hook?');
        expect(output).toContain('Vortex agentic analysis is available on SonarQube Cloud');
        // Accepted features are installed on disk.
        expect(
          harness.cwd.file(...PROMPT_SCRIPT_DIRS, hookScriptName('prompt-secrets')).exists(),
        ).toBe(true);
        expect(harness.cwd.exists(...HOOKS_JSON_DIRS)).toBe(true);
        const agentsMd = harness.cwd.file(...PROJECT_AGENTS_MD_DIRS).asText();
        expect(agentsMd).toContain(SECRETS_HEADING);
        // No SQAA marker block was written (org not entitled).
        expect(agentsMd).not.toContain(SQAA_HEADING);
        expect(harness.cwd.exists(...CONFIG_TOML_DIRS)).toBe(true);
        // Declarative state records only the accepted features.
        expect(findCodexFeature(harness, 'sonar-secrets-hooks')).toBeDefined();
        expect(findCodexFeature(harness, 'secrets-instructions')).toBeDefined();
        expect(findCodexFeature(harness, 'mcp-server')).toBeDefined();
        expect(findCodexFeature(harness, 'sonar-sqaa-hook')).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it.each([
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ])(
      'prints a non-interactive hint using -p/-g only for a detected AI agent without --non-interactive (isAgent=%s, isInteractive=%s, expectedShownPrompt=%s)',
      async (isAgent, isInteractive, expectedShownPrompt) => {
        const result = await harness.run(
          `integrate codex${isInteractive ? '' : ' --non-interactive'}`,
          {
            ...(isInteractive ? { stdinChunks: ['\r', '\r', '\r', '\r'] } : {}),
            extraEnv: isAgent ? { CODEX_SANDBOX_NETWORK_DISABLED: '1' } : {},
          },
        );

        expect(result.exitCode).toBe(0);
        if (expectedShownPrompt) {
          expectAgentPromptHint(
            result.stdout,
            'Codex',
            'sonar integrate codex -p <project-key>',
            'sonar integrate codex -g',
          );
        } else {
          expectNoAgentPromptHint(result.stdout);
        }
      },
      { timeout: 30000 },
    );

    it(
      'skips a feature when the user declines its prompt',
      async () => {
        // '\r' selects project scope; decline the hook ('n'), accept secrets instructions and MCP ('\r').
        const result = await harness.run('integrate codex', {
          stdinChunks: ['\r', 'n', '\r', '\r'],
        });

        expect(result.exitCode).toBe(0);
        // Hook was declined: no hook artifacts and no state entry.
        expect(harness.cwd.exists('.codex', 'hooks')).toBe(false);
        expect(harness.cwd.exists(...HOOKS_JSON_DIRS)).toBe(false);
        expect(findCodexFeature(harness, 'sonar-secrets-hooks')).toBeUndefined();
        // The accepted features are still installed.
        expect(harness.cwd.file(...PROJECT_AGENTS_MD_DIRS).asText()).toContain(SECRETS_HEADING);
        expect(harness.cwd.exists(...CONFIG_TOML_DIRS)).toBe(true);
        expect(findCodexFeature(harness, 'secrets-instructions')).toBeDefined();
        expect(findCodexFeature(harness, 'mcp-server')).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'asks a custom question for secrets instructions when global instructions already exist',
      async () => {
        // Seed a previously-installed global secrets-instructions feature so the
        // state probe (isFeatureInstalledGloballyForProject) fires for the project run.
        harness
          .state()
          .withInstalledIntegrationFeature(codexIntegration, 'secrets-instructions', 'global');

        // Project install hits the state-probe branch: the secrets-instructions
        // feature asks a custom "project-local copy" question instead of the
        // default one. The leading '\r' selects project scope first.
        const result = await harness.run('integrate codex', {
          stdinChunks: ['\r', '\r', '\r', '\r'],
        });

        expect(result.exitCode).toBe(0);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).toContain(
          'Global Codex instructions already exist. Do you also want to create a project-local copy for this repo?',
        );
        // Accepting writes the project-local copy and records the project-scope feature.
        expect(harness.cwd.file(...PROJECT_AGENTS_MD_DIRS).asText()).toContain(SECRETS_HEADING);
        expect(findCodexFeature(harness, 'secrets-instructions', 'project')).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'asks before installing the SQAA hook when the org is entitled and a project key is known',
      async () => {
        const testOrg = 'my-org';
        const testProject = 'my-project';
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: testOrg, name: 'My Org' }])
          .withSqaaEntitlement(testOrg, 'test-uuid-1234')
          .withProject(testProject)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', testOrg);

        const result = await harness.run(`integrate codex --project ${testProject}`, {
          stdinChunks: ['\r', '\r', '\r', '\r', '\r'],
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).toContain('Install Vortex agentic analysis hook?');
        expect(
          harness.cwd.file(...SQAA_SCRIPT_DIRS, hookScriptName('posttool-sqaa')).exists(),
        ).toBe(true);
        expect(findCodexFeature(harness, 'sonar-sqaa-hook')).toBeDefined();
      },
      { timeout: 30000 },
    );
  });
});
