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

// Integration tests for `sonar integrate antigravity`.

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { VORTEX_HOOK_MARKER } from '@/commands/integrate/_common/features/context-augmentation-feature.ts';
import { SQAA_INSTRUCTIONS_GLOBAL_SUBFEATURE_ID } from '@/commands/integrate/_common/features/sqaa-instructions-feature.ts';
import { VORTEX_FEATURE_ID } from '@/commands/integrate/_common/vortex.ts';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '@/core/host/install/install-types.ts';
import type { CliState } from '@/core/state/state.ts';

import {
  expectAgentPromptHint,
  expectNoAgentPromptHint,
} from '../../../_common/agent-hint-assertions.js';
import { type CliResult, IS_WINDOWS, normalizePath, TestHarness } from '../../harness';
import {
  type AntigravityHooksJson,
  findAntigravityFeature,
  GLOBAL_GEMINI_MD_PATH,
  GLOBAL_HOOK_SCRIPT_PATH,
  GLOBAL_HOOKS_JSON_PATH,
  GLOBAL_MCP_CONFIG_PATH,
  writeExistingGlobalGeminiRules,
} from './antigravity-test-helpers';

const TEST_PROJECT = 'my-project';
const TEST_ORG = 'my-org';

describe('integrate antigravity', () => {
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
    expect(result.stdout).toContain('antigravity');
  });

  describe('install (global by default)', () => {
    it(
      'writes hook script, hooks.json, and prompt-secrets snippet in ~/.gemini/GEMINI.md',
      async () => {
        const result = await harness.run('integrate antigravity --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.exists(...GLOBAL_HOOK_SCRIPT_PATH)).toBe(true);
        expect(harness.userHome.exists(...GLOBAL_HOOKS_JSON_PATH)).toBe(true);
        expect(harness.userHome.exists(...GLOBAL_GEMINI_MD_PATH)).toBe(true);
        const gemini = harness.userHome.file(...GLOBAL_GEMINI_MD_PATH).asText();
        expect(gemini).toContain('# SonarQube secrets scanning for prompts protocol');

        const json = harness.userHome
          .file(...GLOBAL_HOOKS_JSON_PATH)
          .asJson() as AntigravityHooksJson;
        const command = normalizePath(
          json['sonar-secrets']?.PreToolUse?.[0]?.hooks?.[0]?.command ?? '',
        );
        const homePathNorm = normalizePath(harness.userHome.path);
        expect(command.startsWith(IS_WINDOWS ? 'powershell' : 'bash')).toBe(true);
        expect(command.includes(homePathNorm)).toBe(true);
        expect(command).toContain('.gemini/config/sonar/hooks');
        expect(json['sonar-secrets']?.enabled).toBe(true);
        expect(json['sonar-secrets']?.PreToolUse?.[0]?.matcher).toBe('view_file');

        const scriptBody = harness.userHome.file(...GLOBAL_HOOK_SCRIPT_PATH).asText();
        expect(scriptBody).toContain('sonar hook antigravity-pre-tool-use');

        expect(harness.userHome.exists(...GLOBAL_MCP_CONFIG_PATH)).toBe(true);
        const mcp = harness.userHome.file(...GLOBAL_MCP_CONFIG_PATH).asJson() as {
          mcpServers?: { sonarqube?: { command?: string; args?: string[] } };
        };
        expect(mcp.mcpServers?.sonarqube?.command).toBe('sonar');
        expect(mcp.mcpServers?.sonarqube?.args?.slice(0, 2)).toEqual(['run', 'mcp']);
        expect(mcp.mcpServers?.sonarqube?.args ?? []).not.toContain('--project');
        expect(findAntigravityFeature(harness, 'mcp-server', 'global')).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'records secrets hooks and instructions as global features',
      async () => {
        await harness.run('integrate antigravity --non-interactive');

        expect(findAntigravityFeature(harness, 'sonar-secrets-hooks', 'global')).toBeDefined();
        expect(
          findAntigravityFeature(harness, 'prompt-secrets-global-rules', 'global'),
        ).toBeDefined();

        const expectedGlobalRoot = join(harness.userHome.path, '.gemini', 'config');
        expect(findAntigravityFeature(harness, 'sonar-secrets-hooks', 'global')?.targetRoot).toBe(
          expectedGlobalRoot,
        );
      },
      { timeout: 30000 },
    );

    it(
      'is idempotent on re-run (health check / repair)',
      async () => {
        await harness.run('integrate antigravity --non-interactive');
        const result = await harness.run('integrate antigravity --non-interactive');

        expect(result.exitCode).toBe(0);
        const gemini = harness.userHome.file(...GLOBAL_GEMINI_MD_PATH).asText();
        const headingCount =
          gemini.split('# SonarQube secrets scanning for prompts protocol').length - 1;
        expect(headingCount).toBe(1);
      },
      { timeout: 60000 },
    );

    it(
      'preserves unrelated hooks.json blocks',
      async () => {
        harness.userHome.writeFile(
          join('.gemini', 'config', 'hooks.json'),
          JSON.stringify({
            'other-hook': {
              PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }],
            },
          }),
        );

        const result = await harness.run('integrate antigravity --non-interactive');
        expect(result.exitCode).toBe(0);

        const hooksJson = harness.userHome
          .file(...GLOBAL_HOOKS_JSON_PATH)
          .asJson() as AntigravityHooksJson;
        expect(hooksJson['other-hook']).toBeDefined();
        expect(hooksJson['sonar-secrets']).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'preserves pre-existing GEMINI.md content and appends the managed prompt-secrets block',
      async () => {
        writeExistingGlobalGeminiRules(harness);

        const result = await harness.run('integrate antigravity --non-interactive');

        expect(result.exitCode).toBe(0);
        const body = harness.userHome.file(...GLOBAL_GEMINI_MD_PATH).asText();
        expect(body).toContain('# pre-existing global rules');
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
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
        const extraEnv: Record<string, string> = isAgent ? { ANTIGRAVITY_AGENT: '1' } : {};
        let result: CliResult;
        if (isInteractive) {
          const session = harness.runInteractive('integrate antigravity', {
            extraEnv,
          });
          await session.accept('Install secret scanning hooks?');
          await session.accept('Install MCP server?');
          await session.accept('Install prompt-secrets global rules?');
          result = await session.waitFinish();
        } else {
          result = await harness.run('integrate antigravity --non-interactive', { extraEnv });
        }

        expect(result.exitCode).toBe(0);
        if (expectedShownPrompt) {
          expectAgentPromptHint(result.stdout, 'sonar integrate antigravity --non-interactive');
        } else {
          expectNoAgentPromptHint(result.stdout);
        }
      },
      { timeout: 30000 },
    );
  });

  describe('authentication and cloud org', () => {
    it(
      'exits with error when user is not authenticated',
      async () => {
        const unauthHarness = await TestHarness.create();
        try {
          const result = await unauthHarness.run('integrate antigravity --non-interactive');

          expect(result.exitCode).toBe(1);
          expect(result.stdout + result.stderr).toContain('Not authenticated');
        } finally {
          await unauthHarness.dispose();
        }
      },
      { timeout: 15000 },
    );

    it(
      'fails clearly when SonarQube Cloud org is missing',
      async () => {
        const cloudHarness = await TestHarness.create();
        try {
          const server = await cloudHarness.newFakeServer().withAuthToken('cloud-token').start();
          const serverUrl = server.baseUrl();
          cloudHarness.withAuth(serverUrl, 'cloud-token');
          cloudHarness.state().withSecretsBinaryInstalled();

          const result = await cloudHarness.run('integrate antigravity --non-interactive', {
            extraEnv: {
              SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
              SONARQUBE_CLI_SONARCLOUD_API_URL: `${serverUrl}/api`,
            },
          });

          expect(result.exitCode).toBe(1);
          expect(result.stdout + result.stderr).toContain(
            'SonarQube Cloud requires an organization',
          );
        } finally {
          await cloudHarness.dispose();
        }
      },
      { timeout: 30000 },
    );
  });

  describe('--help', () => {
    it(
      'documents options consistent with other agent integrate commands, with no scope flags',
      async () => {
        const result = await harness.run('integrate antigravity --help');

        expect(result.exitCode).toBe(0);
        const help = result.stdout;
        expect(help).toContain('--non-interactive');
        expect(help).not.toContain('--project');
        expect(help).not.toContain('--global');
      },
      { timeout: 15000 },
    );
  });

  describe('Vortex (SQAA rules)', () => {
    it(
      'writes the SQAA rules into the global GEMINI.md and nothing for Context Augmentation when entitled, with a discovered project key',
      async () => {
        const legacySkillPath = [
          '.gemini',
          'config',
          'skills',
          'sonar-context-augmentation',
          'SKILL.md',
        ];
        harness.userHome.writeFile(join(...legacySkillPath), '# stale skill\n');
        harness.cwd.writeFile('sonar-project.properties', `sonar.projectKey=${TEST_PROJECT}\n`);
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
          .withVortexEntitlement(TEST_ORG, 'test-uuid-1234')
          .withProject(TEST_PROJECT)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

        const result = await harness.run('integrate antigravity --non-interactive', {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        // Antigravity has no global rules directory, so the protocol goes into
        // the user's shared GEMINI.md rather than a rule file.
        const gemini = harness.userHome.file(...GLOBAL_GEMINI_MD_PATH).asText();
        expect(gemini).toContain('# Vortex analysis protocol');
        expect(gemini).toContain('sonar analyze agentic --depth DEEP');
        const vortexFeature = findAntigravityFeature(harness, VORTEX_FEATURE_ID, 'global');
        expect(vortexFeature?.subfeatures?.map((subfeature) => subfeature.featureId)).toEqual([
          SQAA_INSTRUCTIONS_GLOBAL_SUBFEATURE_ID,
        ]);

        expect(harness.userHome.exists(...legacySkillPath)).toBe(false);
        expect(harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asText()).not.toContain(
          VORTEX_HOOK_MARKER,
        );
        const state = harness.stateJsonFile.asJson() as CliState;
        const dependencyIds = state.dependencies.installed.map((dependency) => dependency.id);
        expect(dependencyIds).not.toContain(CONTEXT_AUGMENTATION_BINARY_NAME);
      },
      { timeout: 30000 },
    );

    it(
      'does not install Vortex when the org has no entitlement',
      async () => {
        const result = await harness.run('integrate antigravity --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.file(...GLOBAL_GEMINI_MD_PATH).asText()).not.toContain(
          '# Vortex analysis protocol',
        );
        expect(findAntigravityFeature(harness, VORTEX_FEATURE_ID)).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it(
      'installs Vortex without a project key when entitled',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
          .withVortexEntitlement(TEST_ORG, 'test-uuid-1234')
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

        const result = await harness.run('integrate antigravity --non-interactive', {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.file(...GLOBAL_GEMINI_MD_PATH).asText()).toContain(
          '# Vortex analysis protocol',
        );
        expect(findAntigravityFeature(harness, VORTEX_FEATURE_ID)?.scope).toBe('global');
      },
      { timeout: 30000 },
    );

    it(
      're-running does not duplicate the SQAA rule when entitled',
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

        const extraEnv = {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        };
        await harness.run('integrate antigravity --non-interactive', { extraEnv });
        await harness.run('integrate antigravity --non-interactive', { extraEnv });

        const body = harness.userHome.file(...GLOBAL_GEMINI_MD_PATH).asText();
        expect(body.match(/# Vortex analysis protocol/g)?.length).toBe(1);
      },
      { timeout: 60000 },
    );
  });

  describe('MCP server', () => {
    it(
      'preserves unrelated MCP servers on install',
      async () => {
        harness.userHome.writeFile(
          join('.gemini', 'config', 'mcp_config.json'),
          JSON.stringify({
            mcpServers: {
              other: { command: 'other-mcp', args: [] },
            },
          }),
        );

        await harness.run('integrate antigravity --non-interactive');

        const mcp = harness.userHome.file(...GLOBAL_MCP_CONFIG_PATH).asJson() as {
          mcpServers?: Record<string, { command?: string }>;
        };
        expect(mcp.mcpServers?.other?.command).toBe('other-mcp');
        expect(mcp.mcpServers?.sonarqube?.command).toBe('sonar');
      },
      { timeout: 30000 },
    );

    it(
      'omits --project even when a project key is discovered',
      async () => {
        harness.cwd.writeFile('sonar-project.properties', `sonar.projectKey=${TEST_PROJECT}\n`);
        await harness.run('integrate antigravity --non-interactive');

        const mcp = harness.userHome.file(...GLOBAL_MCP_CONFIG_PATH).asJson() as {
          mcpServers?: { sonarqube?: { args?: string[] } };
        };
        const args = mcp.mcpServers?.sonarqube?.args ?? [];
        expect(args.slice(0, 2)).toEqual(['run', 'mcp']);
        expect(args).not.toContain('--project');
        expect(args).not.toContain(TEST_PROJECT);
      },
      { timeout: 30000 },
    );

    it(
      'replaces a stale sonarqube MCP entry that had --project',
      async () => {
        harness.userHome.writeFile(
          join('.gemini', 'config', 'mcp_config.json'),
          JSON.stringify({
            mcpServers: {
              sonarqube: {
                command: 'sonar.exe',
                args: ['run', 'mcp', '--project', 'proj-a'],
              },
            },
          }),
        );

        const result = await harness.run('integrate antigravity --non-interactive');

        expect(result.exitCode).toBe(0);

        const mcp = harness.userHome.file(...GLOBAL_MCP_CONFIG_PATH).asJson() as {
          mcpServers?: { sonarqube?: { command?: string; args?: string[] } };
        };
        expect(mcp.mcpServers?.sonarqube?.args).toEqual(['run', 'mcp']);
        expect(mcp.mcpServers?.sonarqube?.command).toBe('sonar');
      },
      { timeout: 30000 },
    );

    it(
      'is idempotent on MCP re-run',
      async () => {
        await harness.run('integrate antigravity --non-interactive');
        await harness.run('integrate antigravity --non-interactive');

        const mcp = harness.userHome.file(...GLOBAL_MCP_CONFIG_PATH).asJson() as {
          mcpServers?: Record<string, unknown>;
        };
        expect(Object.keys(mcp.mcpServers ?? {})).toEqual(['sonarqube']);
      },
      { timeout: 60000 },
    );
  });
});
