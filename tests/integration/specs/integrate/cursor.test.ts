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

// Integration tests for `sonar integrate cursor`.
// PR 1 (CLI-619): covers MCP server setup, scope semantics, idempotency, and
// state recording. Hook and CAG tests are added in subsequent PRs.

import { cpSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { VORTEX_PROMOTION_MESSAGE } from '../../../../src/commands/integrate/_common/vortex.ts';
import { cursorIntegration } from '../../../../src/commands/integrate/cursor/declaration';
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
import { findInstalledFeature, getInstalledIntegration } from './state-helpers';

const MCP_JSON_DIRS = ['.cursor', 'mcp.json'];
const SQAA_RULE_DIRS = ['.cursor', 'rules', 'sonar-agentic-analysis.mdc'];
const HOOK_BUILD_SCRIPT_DIRS = ['.cursor', 'hooks', 'sonar-secrets', 'build-scripts'];
const HOOKS_JSON_DIRS = ['.cursor', 'hooks.json'];

interface CursorMcpFile {
  mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
}

type CursorHookEntry = { command?: string; matcher?: string };

interface CursorHooksFile {
  version?: number;
  hooks?: {
    beforeSubmitPrompt?: CursorHookEntry[];
    beforeReadFile?: CursorHookEntry[];
    preToolUse?: CursorHookEntry[];
  };
}

describe('integrate cursor', () => {
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

  it('is listed in sonar integrate --help', async () => {
    const result = await harness.run('integrate --help');
    expect(result.stdout).toContain('cursor');
  });

  describe('project-level install (default)', () => {
    it(
      'writes .cursor/mcp.json with a sonarqube MCP server entry',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withProject('my-project')
          .start();
        harness.withAuth(server.baseUrl(), 'test-token');
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
        );

        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...MCP_JSON_DIRS)).toBe(true);

        const mcp: CursorMcpFile = harness.cwd.file(...MCP_JSON_DIRS).asJson();
        expect(mcp.mcpServers?.sonarqube).toBeDefined();
        expect(mcp.mcpServers?.sonarqube?.command).toBe('sonar');
        expect(mcp.mcpServers?.sonarqube?.args).toContain('mcp');
        expect(mcp.mcpServers?.sonarqube).not.toHaveProperty('env');
      },
      { timeout: 30000 },
    );

    it(
      'forwards SONAR_USER_HOME into the MCP server env and refreshes a prior entry',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withProject('my-project')
          .start();
        harness.withAuth(server.baseUrl(), 'test-token');
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
        );

        const first = await harness.run('integrate cursor --non-interactive');
        expect(first.exitCode).toBe(0);
        expect(
          (harness.cwd.file(...MCP_JSON_DIRS).asJson() as CursorMcpFile).mcpServers?.sonarqube,
        ).not.toHaveProperty('env');

        // Distinct from $HOME/.sonar. Copy cliHome because harness.run() always
        // writes state there, and the child with a custom home must still find auth.
        const customHome = join(harness.userHome.path, 'custom-sonar');
        cpSync(harness.cliHome.path, join(customHome, 'sonarqube-cli'), { recursive: true });
        const result = await harness.run('integrate cursor --non-interactive', {
          extraEnv: { [ENV_SONAR_USER_HOME]: customHome },
        });

        expect(result.exitCode).toBe(0);
        const mcp: CursorMcpFile = harness.cwd.file(...MCP_JSON_DIRS).asJson();
        expect(mcp.mcpServers?.sonarqube?.env?.[ENV_SONAR_USER_HOME]).toBe(customHome);
      },
      { timeout: 30000 },
    );

    it(
      'records mcp-server feature in state with project scope',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withProject('my-project')
          .start();
        harness.withAuth(server.baseUrl(), 'test-token');
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
        );

        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(0);

        const integration = getInstalledIntegration(harness, 'cursor');
        expect(integration).toBeDefined();
        expect(integration!.features.map((f) => f.featureId).sort()).toEqual([
          'mcp-server',
          'sonar-secrets-hooks',
        ]);

        const mcpFeature = findInstalledFeature(harness, 'cursor', 'mcp-server');
        expect(mcpFeature).toMatchObject({
          scope: 'project',
          resources: [
            {
              id: 'cursor-mcp-config',
              resourceType: 'json-patch',
              path: harness.cwd.file(...MCP_JSON_DIRS).path,
            },
          ],
        });
      },
      { timeout: 30000 },
    );

    it(
      'uses a project-relative command path so the config is portable',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withProject('my-project')
          .start();
        harness.withAuth(server.baseUrl(), 'test-token');
        harness.cwd.writeFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
        );

        await harness.run('integrate cursor --non-interactive');

        const mcp: CursorMcpFile = harness.cwd.file(...MCP_JSON_DIRS).asJson();
        expect(mcp.mcpServers?.sonarqube?.args).toContain('my-project');
      },
      { timeout: 30000 },
    );

    it(
      're-running is idempotent — does not duplicate mcpServers entries',
      async () => {
        await harness.run('integrate cursor --non-interactive');
        const firstBody = harness.cwd.file(...MCP_JSON_DIRS).asText();

        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.file(...MCP_JSON_DIRS).asText()).toBe(firstBody);

        const mcp: CursorMcpFile = harness.cwd.file(...MCP_JSON_DIRS).asJson();
        expect(Object.keys(mcp.mcpServers ?? {})).toHaveLength(1);
      },
      { timeout: 30000 },
    );

    it(
      'fails when the existing .cursor/mcp.json contains invalid JSON',
      async () => {
        harness.cwd.writeFile('.cursor/mcp.json', '{ invalid json');

        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('invalid JSON');
      },
      { timeout: 30000 },
    );
  });

  describe('global install (-g)', () => {
    it(
      'writes to ~/.cursor/mcp.json and not to the project directory',
      async () => {
        const result = await harness.run('integrate cursor -g --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...MCP_JSON_DIRS)).toBe(false);
        expect(harness.userHome.exists(...MCP_JSON_DIRS)).toBe(true);

        const mcp: CursorMcpFile = harness.userHome.file(...MCP_JSON_DIRS).asJson();
        expect(mcp.mcpServers?.sonarqube).toBeDefined();
        expect(mcp.mcpServers?.sonarqube?.args).toContain('mcp');
      },
      { timeout: 30000 },
    );

    it(
      'records mcp-server feature with global scope in state',
      async () => {
        const result = await harness.run('integrate cursor -g --non-interactive');

        expect(result.exitCode).toBe(0);

        const mcpFeature = findInstalledFeature(harness, 'cursor', 'mcp-server', 'global');
        expect(mcpFeature).toBeDefined();
        expect(mcpFeature).toMatchObject({
          scope: 'global',
          resources: [
            {
              id: 'cursor-mcp-config',
              resourceType: 'json-patch',
              path: harness.userHome.file(...MCP_JSON_DIRS).path,
            },
          ],
        });
      },
      { timeout: 30000 },
    );

    it(
      'emits a warning that cloud agents only pick up project-level hooks',
      async () => {
        const result = await harness.run('integrate cursor -g --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('cloud');
      },
      { timeout: 30000 },
    );
  });

  describe('secrets scanning hooks', () => {
    it(
      'writes an executable beforeSubmitPrompt script and a hooks.json entry under .cursor/',
      async () => {
        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(0);

        const scriptFile = harness.cwd.file(
          ...HOOK_BUILD_SCRIPT_DIRS,
          hookScriptName('prompt-secrets'),
        );
        expect(scriptFile.exists()).toBe(true);
        expect(scriptFile.isExecutable).toBe(true);

        const hooks: CursorHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        expect(hooks.version).toBe(1);
        const entry = hooks.hooks?.beforeSubmitPrompt?.[0];
        expect(entry?.command).toContain('sonar-secrets');
        expect(entry?.matcher).toBe('UserPromptSubmit');
      },
      { timeout: 30000 },
    );

    it(
      'writes executable beforeReadFile and preToolUse scripts with correct matchers',
      async () => {
        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(0);

        const preReadScript = harness.cwd.file(
          ...HOOK_BUILD_SCRIPT_DIRS,
          hookScriptName('before-read-file-secrets'),
        );
        const preToolScript = harness.cwd.file(
          ...HOOK_BUILD_SCRIPT_DIRS,
          hookScriptName('pre-tool-use-secrets'),
        );
        expect(preReadScript.exists()).toBe(true);
        expect(preReadScript.isExecutable).toBe(true);
        expect(preToolScript.exists()).toBe(true);
        expect(preToolScript.isExecutable).toBe(true);

        // A wrong matcher (e.g. "*") is invalid regex and silently disables the hook.
        // beforeReadFile uses Read|TabRead (TabRead covers Tab completion reads).
        // preToolUse uses Read only — TabRead is not a valid preToolUse tool type per Cursor docs.
        const hooks: CursorHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const beforeReadFile = hooks.hooks?.beforeReadFile?.[0];
        const preToolUse = hooks.hooks?.preToolUse?.[0];
        expect(beforeReadFile?.command).toContain('sonar-secrets');
        expect(beforeReadFile?.matcher).toBe('Read|TabRead');
        expect(preToolUse?.command).toContain('sonar-secrets');
        expect(preToolUse?.matcher).toBe('Read');
      },
      { timeout: 30000 },
    );

    it(
      'uses a project-relative command path so the config is portable',
      async () => {
        await harness.run('integrate cursor --non-interactive');

        const hooks: CursorHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const command = hookScriptPath(String(hooks.hooks?.beforeSubmitPrompt?.[0]?.command));
        expect(isAbsolute(command)).toBe(false);
        expect(command.startsWith('.cursor/')).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'records the sonar-secrets-hooks feature and the sonar-secrets dependency in state',
      async () => {
        await harness.run('integrate cursor --non-interactive');

        const feature = findInstalledFeature(harness, 'cursor', 'sonar-secrets-hooks', 'project');
        expect(feature).toBeDefined();
        expect(feature?.dependencies?.some((d) => d.id === 'sonar-secrets')).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      're-running does not duplicate the beforeSubmitPrompt entry',
      async () => {
        await harness.run('integrate cursor --non-interactive');
        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(0);
        const hooks: CursorHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        expect(hooks.hooks?.beforeSubmitPrompt).toHaveLength(1);
      },
      { timeout: 30000 },
    );

    it(
      'preserves pre-existing non-Sonar entries in hooks.json across re-install',
      async () => {
        harness.cwd.writeFile(
          '.cursor/hooks.json',
          JSON.stringify({
            version: 1,
            hooks: {
              beforeSubmitPrompt: [{ command: '.cursor/hooks/other-tool/run.sh' }],
            },
          }),
        );

        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(0);
        const hooks: CursorHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const commands = hooks.hooks?.beforeSubmitPrompt?.map((entry) => entry.command);
        expect(commands?.some((command) => command?.includes('other-tool'))).toBe(true);
        expect(commands?.some((command) => command?.includes('sonar-secrets'))).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'tolerates hand-edited entries whose command is missing or non-string',
      async () => {
        harness.cwd.writeFile(
          '.cursor/hooks.json',
          JSON.stringify({
            version: 1,
            hooks: {
              beforeSubmitPrompt: [{}, { command: 123 }, { command: '.cursor/other/run.sh' }],
            },
          }),
        );

        // The malformed entries must not crash the install (the guard skips them); the sonar
        // hook is still appended alongside the preserved (untouched) entries.
        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(0);
        const hooks: CursorHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const commands = hooks.hooks?.beforeSubmitPrompt?.map((entry) => entry.command);
        expect(
          commands?.some(
            (command) => typeof command === 'string' && command.includes('sonar-secrets'),
          ),
        ).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'tolerates a hand-edited event value that is not an array',
      async () => {
        harness.cwd.writeFile(
          '.cursor/hooks.json',
          JSON.stringify({
            version: 1,
            // A user hand-edited the event to an object instead of an array.
            hooks: { beforeSubmitPrompt: {} },
          }),
        );

        // A non-array event value must not crash the install; it is treated as empty and the
        // sonar hook is appended as a well-formed array.
        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(0);
        const hooks: CursorHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        expect(Array.isArray(hooks.hooks?.beforeSubmitPrompt)).toBe(true);
        const commands = hooks.hooks?.beforeSubmitPrompt?.map((entry) => entry.command);
        expect(
          commands?.some(
            (command) => typeof command === 'string' && command.includes('sonar-secrets'),
          ),
        ).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'writes script + hooks.json under $HOME/.cursor/ with an absolute command path (global)',
      async () => {
        const result = await harness.run('integrate cursor -g --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(
          harness.userHome.exists(...HOOK_BUILD_SCRIPT_DIRS, hookScriptName('prompt-secrets')),
        ).toBe(true);

        const hooks: CursorHooksFile = harness.userHome.file(...HOOKS_JSON_DIRS).asJson();
        const command = hookScriptPath(String(hooks.hooks?.beforeSubmitPrompt?.[0]?.command));
        expect(isAbsolute(command)).toBe(true);
        expect(command.startsWith(normalizePath(harness.userHome.path))).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'skips the project-level secrets hook when a global Cursor hook is already recorded',
      async () => {
        harness
          .state()
          .withInstalledIntegrationFeature(cursorIntegration, 'sonar-secrets-hooks', 'global');

        const result = await harness.run('integrate cursor --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
          'A global secrets scanning hook is already configured. Skipping project-level secrets hooks to avoid duplicate execution.',
        );
        expect(harness.cwd.exists('.cursor', 'hooks')).toBe(false);
        expect(harness.cwd.exists(...HOOKS_JSON_DIRS)).toBe(false);
        expect(
          findInstalledFeature(harness, 'cursor', 'sonar-secrets-hooks', 'project'),
        ).toBeUndefined();
        // The MCP server feature still installs.
        expect(harness.cwd.exists(...MCP_JSON_DIRS)).toBe(true);
      },
      { timeout: 30000 },
    );
  });

  describe('Vortex entitlement and SQAA instructions', () => {
    const TEST_ORG = 'my-org';
    const TEST_PROJECT = 'my-project';

    // Stand up a fake SonarQube Cloud server with Vortex entitlement for the test
    // org, swap the harness auth to a cloud connection, and return env vars that
    // point the CLI's hard-coded SonarCloud URL constants at the fake server.
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
      'writes an always-applied .cursor/rules/sonar-agentic-analysis.mdc when entitled, project scope, with a project key',
      async () => {
        harness.state().withContextAugmentationBinaryInstalled();
        const { extraEnv } = await setupCloudWithEntitlement();

        const result = await harness.run(
          `integrate cursor --project ${TEST_PROJECT} --non-interactive`,
          { extraEnv },
        );

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...SQAA_RULE_DIRS)).toBe(true);

        const body = harness.cwd.file(...SQAA_RULE_DIRS).asText();
        // Cursor auto-loads the rule in every session via the front-matter.
        expect(body).toContain('alwaysApply: true');
        expect(body).toContain('# Vortex analysis protocol');
        expect(body).toContain(`sonar analyze agentic --project ${TEST_PROJECT}`);
        expect(body).toContain('--file');

        expect(findInstalledFeature(harness, 'cursor', 'vortex', 'project')).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'prompts to install Vortex and writes the rule when accepted (entitled org, interactive)',
      async () => {
        const { extraEnv } = await setupCloudWithEntitlement();

        const session = harness.runInteractive(`integrate cursor --project ${TEST_PROJECT}`, {
          extraEnv: { ...extraEnv, __SQCLI_DEV_SKIP_CAG: '1' },
        });
        await session.accept('Install secret scanning hooks?');
        await session.accept('Install Vortex?');
        await session.accept('Install MCP server?');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(0);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Install Vortex?');
        const body = harness.cwd.file(...SQAA_RULE_DIRS).asText();
        expect(body).toContain('# Vortex analysis protocol');
        expect(findInstalledFeature(harness, 'cursor', 'vortex', 'project')).toBeDefined();
      },
      { timeout: 30000 },
    );

    it.each([
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ])(
      'prints a non-interactive hint with --non-interactive plus -p/-g examples only for a detected AI agent without --non-interactive (isAgent=%s, isInteractive=%s, expectedShownPrompt=%s)',
      async (isAgent, isInteractive, expectedShownPrompt) => {
        const { extraEnv } = await setupCloudWithEntitlement();

        const runEnv = {
          ...extraEnv,
          __SQCLI_DEV_SKIP_CAG: '1',
          ...(isAgent ? { CURSOR_AGENT: '1' } : {}),
        };
        let result: CliResult;
        if (isInteractive) {
          const session = harness.runInteractive(`integrate cursor --project ${TEST_PROJECT}`, {
            extraEnv: runEnv,
          });
          await session.accept('Install secret scanning hooks?');
          await session.accept('Install Vortex?');
          await session.accept('Install MCP server?');
          result = await session.waitFinish();
        } else {
          result = await harness.run(
            `integrate cursor --project ${TEST_PROJECT} --non-interactive`,
            { extraEnv: runEnv },
          );
        }

        expect(result.exitCode).toBe(0);
        if (expectedShownPrompt) {
          expectAgentPromptHint(
            result.stdout,
            'sonar integrate cursor --non-interactive',
            'sonar integrate cursor --non-interactive -g',
          );
        } else {
          expectNoAgentPromptHint(result.stdout);
        }
      },
      { timeout: 30000 },
    );

    it(
      'skips the SQAA rule under -g even when entitled, and warns',
      async () => {
        // `--global` and `--project` are mutually exclusive, so the project key
        // is discovered from disk in the global flow.
        const { extraEnv } = await setupCloudWithEntitlement();
        harness.cwd.writeFile('sonar-project.properties', `sonar.projectKey=${TEST_PROJECT}\n`);

        const result = await harness.run('integrate cursor -g --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('not supported with --global');
        // Never written project-side on a global install.
        expect(harness.cwd.file(...SQAA_RULE_DIRS).exists()).toBe(false);
        expect(findInstalledFeature(harness, 'cursor', 'vortex')).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it(
      'omits the SQAA rule when no project key is provided or discoverable',
      async () => {
        const { extraEnv } = await setupCloudWithEntitlement();

        const result = await harness.run('integrate cursor --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.file(...SQAA_RULE_DIRS).exists()).toBe(false);
        expect(findInstalledFeature(harness, 'cursor', 'vortex')).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it(
      'skips Vortex and shows the promotion message when the org is not entitled',
      async () => {
        const { extraEnv } = await setupCloudWithEntitlement({
          allowed: false,
          hasEntitlement: false,
        });

        const result = await harness.run(
          `integrate cursor --project ${TEST_PROJECT} --non-interactive`,
          { extraEnv },
        );

        expect(result.exitCode).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_PROMOTION_MESSAGE);
        expect(harness.cwd.file(...SQAA_RULE_DIRS).exists()).toBe(false);
        expect(findInstalledFeature(harness, 'cursor', 'vortex')).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it(
      're-running is idempotent — rule body is unchanged',
      async () => {
        harness.state().withContextAugmentationBinaryInstalled();
        const { extraEnv } = await setupCloudWithEntitlement();

        await harness.run(`integrate cursor --project ${TEST_PROJECT} --non-interactive`, {
          extraEnv,
        });
        const firstBody = harness.cwd.file(...SQAA_RULE_DIRS).asText();

        const result = await harness.run(
          `integrate cursor --project ${TEST_PROJECT} --non-interactive`,
          { extraEnv },
        );

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.file(...SQAA_RULE_DIRS).asText()).toBe(firstBody);
      },
      { timeout: 30000 },
    );

    it(
      'system reset removes the SQAA rule file',
      async () => {
        harness.state().withContextAugmentationBinaryInstalled();
        const { extraEnv } = await setupCloudWithEntitlement();

        const integrateResult = await harness.run(
          `integrate cursor --project ${TEST_PROJECT} --non-interactive`,
          { extraEnv },
        );
        expect(integrateResult.exitCode).toBe(0);
        expect(harness.cwd.exists(...SQAA_RULE_DIRS)).toBe(true);

        // Preserve the post-integrate state so reset sees the installed features.
        const stateAfterIntegrate = readFileSync(harness.stateJsonFile.path, 'utf-8');
        harness.state().withRawState(stateAfterIntegrate);

        const result = await harness.run('system reset --force');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...SQAA_RULE_DIRS)).toBe(false);
      },
      { timeout: 30000 },
    );
  });

  it(
    'rejects --global combined with --project',
    async () => {
      const result = await harness.run(
        'integrate cursor --global --project my-project --non-interactive',
      );
      expect(result.exitCode).toBe(2);
    },
    { timeout: 30000 },
  );
});
