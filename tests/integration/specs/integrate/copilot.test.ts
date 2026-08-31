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
  HOOK_FIELD,
  makeHookEntry,
  McpJson,
  obstructHooksJson,
  obstructInstructionsFile,
  PRETOOL_SECRETS_SCRIPT,
  PROJECT_HOOK_SCRIPT_PATH,
  PROJECT_HOOKS_JSON_PATH,
  PROJECT_INSTRUCTIONS_PATH,
  writeExistingGlobalHook,
  writeExistingGlobalInstructions,
} from './copilot-test-helpers';

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

  // ─── Project-level install (default) ────────────────────────────────────────

  describe('project-level install (default)', () => {
    it(
      'writes hook script (executable), hooks.json, instructions, and .mcp.json under .github/',
      async () => {
        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(0);

        // Hook script: present and executable.
        const scriptFile = harness.cwd.file(...PROJECT_HOOK_SCRIPT_PATH);
        expect(scriptFile.exists()).toBe(true);
        expect(scriptFile.isExecutable).toBe(true);

        // hooks.json: present.
        expect(harness.cwd.exists('.github', 'hooks', 'hooks.json')).toBe(true);

        // Instructions file: present with the expected heading.
        const instructionsFile = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH);
        expect(instructionsFile.exists()).toBe(true);
        expect(instructionsFile.asText()).toContain(
          '# SonarQube secrets scanning for prompts protocol',
        );

        // .mcp.json: present and registers the sonarqube MCP server using
        // the PATH command `sonar` (Windows PATHEXT resolves sonar.exe).
        expect(harness.cwd.exists('.mcp.json')).toBe(true);
        const mcp: McpJson = harness.cwd.file('.mcp.json').asJson();
        const sonar = mcp.mcpServers?.sonarqube;
        expect(sonar?.command).toBe('sonar');
        expect(sonar?.args?.slice(0, 2)).toEqual(['run', 'mcp']);

        // Completion summary
        expect(result.stdout).toContain('Installed');
        expect(result.stdout).toContain('Setup complete!');
        expect(result.stdout).toContain('paste this into Copilot');
      },
      { timeout: 30000 },
    );

    it(
      'writes a relative-path preToolUse entry in hooks.json with timeoutSec=60',
      async () => {
        await harness.run('integrate copilot --non-interactive');

        const json = harness.cwd.file(...PROJECT_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        expect(json.hooks.preToolUse).toHaveLength(1);
        const entry = json.hooks.preToolUse?.[0] ?? ({} as CopilotHookEntry);
        expect(entry.type).toBe('command');
        expect(entry.timeoutSec).toBe(60);
        const command = entry[HOOK_FIELD] ?? '';
        expect(command.length).toBeGreaterThan(0);
        // Project scope uses paths relative to the project root.
        expect(command.startsWith('/')).toBe(false);
        expect(command).toContain('sonar-secrets');
        expect(command).toContain('pretool-secrets');
      },
      { timeout: 30000 },
    );

    it(
      'does not touch ~/.copilot when running without --global',
      async () => {
        await harness.run('integrate copilot --non-interactive');

        expect(harness.userHome.exists('.copilot')).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'records default project-scope features in integrations.installed',
      async () => {
        await harness.run('integrate copilot --non-interactive');

        const copilotIntegration = getCopilotIntegration(harness);
        expect(copilotIntegration).toBeDefined();
        expect(
          copilotIntegration?.features
            .map((feature: { featureId: string }) => feature.featureId)
            .sort(),
        ).toEqual(['mcp-server', 'pre-tool-use-hook', 'prompt-secrets-instructions']);
        expect(findCopilotFeature(harness, 'pre-tool-use-hook')?.scope).toBe('project');
        expect(findCopilotFeature(harness, 'prompt-secrets-instructions')?.scope).toBe('project');
      },
      { timeout: 30000 },
    );

    it(
      'records declarative Copilot features in integrations.installed for project installs',
      async () => {
        await harness.run('integrate copilot --project my-project --non-interactive');

        const state = harness.stateJsonFile.asJson();
        const copilotIntegration = state.integrations.installed.find(
          (integration: { integrationId: string }) => integration.integrationId === 'copilot-cli',
        );

        expect(copilotIntegration).toBeDefined();
        expect(
          copilotIntegration.features
            .map((feature: { featureId: string }) => feature.featureId)
            .sort(),
        ).toEqual(['mcp-server', 'pre-tool-use-hook', 'prompt-secrets-instructions']);

        const hookFeature = copilotIntegration.features.find(
          (feature: { featureId: string }) => feature.featureId === 'pre-tool-use-hook',
        );
        expect(hookFeature).toMatchObject({
          scope: 'project',
          dependencies: [{ id: 'sonar-secrets' }],
          attrs: {
            projectKey: 'my-project',
          },
        });
        expect(state.dependencies.installed).toMatchObject([
          {
            id: 'sonar-secrets',
          },
        ]);
      },
      { timeout: 30000 },
    );

    it(
      'running twice yields exactly one preToolUse entry in hooks.json',
      async () => {
        await harness.run('integrate copilot --non-interactive');
        await harness.run('integrate copilot --non-interactive');

        const json = harness.cwd.file(...PROJECT_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        expect(json.hooks.preToolUse).toHaveLength(1);
      },
      { timeout: 60000 },
    );

    it(
      'appends --project <key> to the MCP server args when --project is provided',
      async () => {
        await harness.run('integrate copilot --project my-project --non-interactive');

        const mcp = harness.cwd.file('.mcp.json').asJson() as McpJson;
        const args = mcp.mcpServers?.sonarqube?.args ?? [];
        expect(args).toContain('--project');
        const idx = args.indexOf('--project');
        expect(args[idx + 1]).toBe('my-project');
      },
      { timeout: 30000 },
    );

    it(
      'pretool-secrets script uses the correct subcommand (sonar hook copilot-pre-tool-use)',
      async () => {
        await harness.run('integrate copilot --non-interactive');

        const content = harness.cwd.file(...PROJECT_HOOK_SCRIPT_PATH).asText();
        expect(content).toContain('sonar hook copilot-pre-tool-use');
        expect(content).not.toContain('sonar analyze');
      },
      { timeout: 30000 },
    );

    it(
      'preserves unrelated preToolUse entries in a pre-existing project hooks.json',
      async () => {
        harness.cwd.writeFile(
          '.github/hooks/hooks.json',
          JSON.stringify({
            version: 1,
            hooks: {
              preToolUse: [makeHookEntry('/other/tool/run.sh')],
            },
          }),
        );

        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(0);
        const json = harness.cwd.file(...PROJECT_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        const entries = json.hooks.preToolUse ?? [];
        expect(entries).toHaveLength(2);
        expect(entries.find((e) => (e[HOOK_FIELD] ?? '').includes('/other/tool/'))).toBeDefined();
        expect(entries.find((e) => (e[HOOK_FIELD] ?? '').includes('sonar-secrets'))).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'initialises the hooks key when a pre-existing hooks.json lacks it',
      async () => {
        // Bare hooks.json with no top-level `hooks` key. The install must
        // initialise `hooks` (via `hooksJson.hooks ??= {}`) without crashing
        // and without dropping the existing `version` field.
        harness.cwd.writeFile('.github/hooks/hooks.json', JSON.stringify({ version: 1 }));

        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(0);
        const json = harness.cwd.file(...PROJECT_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        expect(json.version).toBe(1);
        const entries = json.hooks.preToolUse ?? [];
        expect(entries).toHaveLength(1);
        expect(entries[0][HOOK_FIELD] ?? '').toContain('sonar-secrets');
      },
      { timeout: 30000 },
    );
  });

  // ─── Global install (-g) ────────────────────────────────────────────────────

  describe('global install (-g)', () => {
    it(
      'writes hook script, hooks.json, instructions, and mcp-config.json under ~/.copilot/',
      async () => {
        const result = await harness.run('integrate copilot -g --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.exists(...GLOBAL_HOOK_SCRIPT_PATH)).toBe(true);
        expect(harness.userHome.exists('.copilot', 'hooks', 'hooks.json')).toBe(true);
        expect(harness.userHome.exists(...GLOBAL_INSTRUCTIONS_PATH)).toBe(true);
        expect(harness.userHome.exists('.copilot', 'mcp-config.json')).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'uses an absolute path in the hooks.json preToolUse entry under ~/.copilot/hooks/',
      async () => {
        await harness.run('integrate copilot -g --non-interactive');

        const json = harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        const command = normalizePath(String(json.hooks.preToolUse?.[0]?.[HOOK_FIELD] ?? ''));
        const homePathNorm = normalizePath(harness.userHome.path);
        expect(command.startsWith(homePathNorm)).toBe(true);
        expect(command).toContain('.copilot/hooks/sonar-secrets');
      },
      { timeout: 30000 },
    );

    it(
      'does not create .github/ inside the project directory when -g is set',
      async () => {
        await harness.run('integrate copilot -g --non-interactive');

        expect(harness.cwd.exists('.github', 'hooks')).toBe(false);
        expect(harness.cwd.exists('.github', 'instructions')).toBe(false);
        expect(harness.cwd.exists('.mcp.json')).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'records hook and prompt instructions as global features in declarative state',
      async () => {
        await harness.run('integrate copilot -g --non-interactive');

        expect(findCopilotFeature(harness, 'pre-tool-use-hook')?.scope).toBe('global');
        expect(findCopilotFeature(harness, 'prompt-secrets-instructions')?.scope).toBe('global');
      },
      { timeout: 30000 },
    );

    it(
      'preserves pre-existing global instructions and appends the managed prompt-secrets block',
      async () => {
        // sonarqube.instructions.md is marker-managed: the CLI only owns
        // its sonar:begin/end block and preserves any surrounding content.
        harness.userHome.writeFile(
          '.copilot/instructions/sonarqube.instructions.md',
          '# pre-existing\n',
        );

        const result = await harness.run('integrate copilot -g --non-interactive');

        expect(result.exitCode).toBe(0);
        const body = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# pre-existing');
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
      },
      { timeout: 30000 },
    );

    it(
      'is idempotent: running -g twice yields exactly one prompt-secrets section',
      async () => {
        await harness.run('integrate copilot -g --non-interactive');
        await harness.run('integrate copilot -g --non-interactive');

        const body = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();
        const headingCount =
          body.split('# SonarQube secrets scanning for prompts protocol').length - 1;
        expect(headingCount).toBe(1);
      },
      { timeout: 60000 },
    );
  });

  // ─── Skip-on-existing-global hook ───────────────────────────────────────────

  describe('project-level install when a global Copilot hook already exists', () => {
    it(
      'skips the project-level hook write and prints the "already configured" notice',
      async () => {
        writeExistingGlobalHook(harness);

        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('.github', 'hooks', 'sonar-secrets')).toBe(false);
        expect(harness.cwd.exists('.github', 'hooks', 'hooks.json')).toBe(false);
        expect(result.stdout).toContain(
          'Skipping the project-level pre-tool-use hook because a global secrets scanning hook is already configured.',
        );
      },
      { timeout: 30000 },
    );

    it(
      'does not record the declarative hook feature when the project-level write was skipped',
      async () => {
        writeExistingGlobalHook(harness);

        await harness.run('integrate copilot --non-interactive');

        expect(findCopilotFeature(harness, 'pre-tool-use-hook')).toBeUndefined();
        // Instructions are independent — the project-level instructions
        // write still runs because the global instructions file does not exist.
        expect(findCopilotFeature(harness, 'prompt-secrets-instructions')?.scope).toBe('project');
      },
      { timeout: 30000 },
    );

    it(
      'leaves the pre-existing global hooks.json byte-identical',
      async () => {
        writeExistingGlobalHook(harness);
        const before = harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asText();

        await harness.run('integrate copilot --non-interactive');

        expect(harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asText()).toBe(before);
      },
      { timeout: 30000 },
    );

    it(
      'falls back to a project-level install (and warns) when the referenced global script is missing (orphaned)',
      async () => {
        // Write hooks.json that references a sonar-secrets script that does not exist on disk.
        const orphanScript = harness.userHome.file(
          `.copilot/hooks/sonar-secrets/build-scripts/${PRETOOL_SECRETS_SCRIPT}`,
        ).path;
        const orphanedJson: CopilotHooksJson = {
          version: 1,
          hooks: { preToolUse: [makeHookEntry(normalizePath(orphanScript))] },
        };
        harness.userHome.writeFile('.copilot/hooks/hooks.json', JSON.stringify(orphanedJson));

        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(result.stderr + result.stdout).toContain(
          'Falling back to project-level installation',
        );
        expect(harness.cwd.exists('.github', 'hooks', 'hooks.json')).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'performs a project-level install when global hooks.json has only an unrelated preToolUse entry',
      async () => {
        // The marker check matches sonar-secrets entries by path substring;
        // an unrelated tool's entry must not short-circuit our install.
        const globalJson: CopilotHooksJson = {
          version: 1,
          hooks: {
            preToolUse: [makeHookEntry('/some/other-tool/script.sh')],
          },
        };
        harness.userHome.writeFile('.copilot/hooks/hooks.json', JSON.stringify(globalJson));
        const before = harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asText();

        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('.github', 'hooks', 'hooks.json')).toBe(true);
        const projectJson = harness.cwd
          .file(...PROJECT_HOOKS_JSON_PATH)
          .asJson() as CopilotHooksJson;
        const projectEntries = projectJson.hooks.preToolUse ?? [];
        expect(projectEntries.some((e) => (e[HOOK_FIELD] ?? '').includes('sonar-secrets'))).toBe(
          true,
        );
        // No "already configured" notice was emitted.
        expect(result.stdout).not.toContain('A global secrets scanning hook is already configured');
        // Global hooks.json was not touched.
        expect(harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asText()).toBe(before);
      },
      { timeout: 30000 },
    );
  });

  // ─── Project-level install when global instructions already exist ──────────

  describe('project-level install when global Copilot instructions already exist', () => {
    it(
      'writes the project-level instructions file and leaves the global file untouched',
      async () => {
        writeExistingGlobalInstructions(harness);
        const before = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();

        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(0);
        // Project file is written despite the global file existing.
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(true);
        expect(harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText()).toContain(
          '# SonarQube secrets scanning for prompts protocol',
        );
        // Global file is byte-identical (orphan; not touched).
        expect(harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText()).toBe(before);
        // Declarative state records the project-scoped prompt-secrets feature.
        expect(findCopilotFeature(harness, 'prompt-secrets-instructions')?.scope).toBe('project');
      },
      { timeout: 30000 },
    );
  });

  // ─── Project-level install when both global hook and instructions exist ────

  describe('project-level install when both global hook and global instructions already exist', () => {
    it(
      'short-circuits the hook only — instructions still install at the project level',
      async () => {
        writeExistingGlobalHook(harness);
        writeExistingGlobalInstructions(harness);

        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(0);
        // Hook is short-circuited; no project-level hook artifacts.
        expect(harness.cwd.exists('.github', 'hooks')).toBe(false);
        // Instructions are independent — the project-level file is written.
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(true);

        const state = harness.stateJsonFile.asJson();
        expect(findCopilotFeature(harness, 'pre-tool-use-hook')).toBeUndefined();
        expect(findCopilotFeature(harness, 'prompt-secrets-instructions')?.scope).toBe('project');

        const copilotIntegration = state.integrations.installed.find(
          (integration: { integrationId: string }) => integration.integrationId === 'copilot-cli',
        );
        expect(copilotIntegration).toBeDefined();
        expect(
          copilotIntegration.features
            .map((feature: { featureId: string }) => feature.featureId)
            .sort(),
        ).toEqual(['mcp-server', 'prompt-secrets-instructions']);
        expect(
          state.dependencies.installed.map((dependency: { id: string }) => dependency.id),
        ).toEqual(['sonar-secrets']);
      },
      { timeout: 30000 },
    );
  });

  // ─── Installation failure handling ──────────────────────────────────────────

  // We force file-system failures by pre-creating artifact paths as
  // directories or by writing invalid JSON. The declarative installer now
  // fails fast, so later features are not applied and declarative state is
  // only recorded for features that completed before the failure.

  describe('installation failure handling', () => {
    it(
      'fails and stops before instructions + MCP when the hook configuration write fails',
      async () => {
        obstructHooksJson(harness);

        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain('contains invalid JSON');

        // The hook feature fails before later features run.
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(false);
        expect(harness.cwd.exists('.mcp.json')).toBe(false);

        // Declarative integration state is not updated because the integration
        // did not complete.
        expect(getCopilotIntegration(harness)).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it(
      'fails and stops before MCP when the instructions write fails',
      async () => {
        obstructInstructionsFile(harness);

        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(1);
        expect(harness.cwd.exists('.mcp.json')).toBe(false);

        // The hook feature completed before the instructions write failed, so
        // only that feature is recorded.
        expect(
          getCopilotIntegration(harness)?.features.map((feature) => feature.featureId),
        ).toEqual(['pre-tool-use-hook']);
      },
      { timeout: 30000 },
    );

    it(
      'fails when the existing MCP config contains invalid JSON',
      async () => {
        harness.cwd.writeFile('.mcp.json', '{ invalid json\n');

        const result = await harness.run('integrate copilot --non-interactive');

        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain('.mcp.json contains invalid JSON');
        expect(
          getCopilotIntegration(harness)?.features.map((feature) => feature.featureId),
        ).toEqual(['pre-tool-use-hook', 'prompt-secrets-instructions']);
      },
      { timeout: 30000 },
    );
  });

  // ─── Option validation ──────────────────────────────────────────────────────

  describe('option validation', () => {
    it(
      'exits with code 2 when both --global and --project are provided',
      async () => {
        const result = await harness.run('integrate copilot --global --project foo');

        expect(result.exitCode).toBe(2);
        expect(result.stdout + result.stderr).toContain(
          '--global and --project are mutually exclusive',
        );
      },
      { timeout: 15000 },
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
      'writes secrets and SQAA as independent marker blocks in the project file when org is entitled, project scope, and project key is provided',
      async () => {
        harness.state().withContextAugmentationBinaryInstalled();
        const { extraEnv } = await setupCloudWithEntitlement();

        const result = await harness.run(
          `integrate copilot --project ${TEST_PROJECT} --non-interactive`,
          {
            extraEnv,
          },
        );

        expect(result.exitCode).toBe(0);
        const body = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).toContain('# Vortex analysis protocol');
        expect(body).toContain(`sonar analyze agentic --project ${TEST_PROJECT}`);
        expect(body).toContain('--file');

        const promptSecrets = findCopilotFeature(harness, 'prompt-secrets-instructions');
        expect(promptSecrets?.scope).toBe('project');
        expect(findCopilotFeature(harness, 'vortex')?.scope).toBe('project');
      },
      { timeout: 30000 },
    );

    it(
      'prompts to install Vortex and writes the SQAA section when accepted (entitled org, interactive)',
      async () => {
        const { extraEnv } = await setupCloudWithEntitlement();

        // Interactive (no --non-interactive): the entitled org makes Vortex an ask.
        const session = harness.runInteractive(`integrate copilot --project ${TEST_PROJECT}`, {
          extraEnv: { ...extraEnv, __SQCLI_DEV_SKIP_CAG: '1' },
        });
        await session.waitText('Install pre-tool-use hook?');
        session.enter();
        await session.waitText('Install prompt-secrets instructions?');
        session.enter();
        await session.waitText('Install Vortex?');
        session.enter();
        await session.waitText('Install MCP server?');
        session.enter();
        const result = await session.finish();

        expect(result.exitCode).toBe(0);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Install Vortex?');
        const body = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# Vortex analysis protocol');
        expect(findCopilotFeature(harness, 'vortex')?.scope).toBe('project');
      },
      { timeout: 30000 },
    );

    it(
      'skips the SQAA section under -g even when org is entitled and a project key is discoverable, and warns',
      async () => {
        // `--global` and `--project` are mutually exclusive on the CLI, so the
        // project key must be discovered from disk in the global flow.
        const { extraEnv } = await setupCloudWithEntitlement();
        harness.cwd.writeFile('sonar-project.properties', `sonar.projectKey=${TEST_PROJECT}\n`);

        const result = await harness.run('integrate copilot -g --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('not supported with --global');

        // Global file holds prompt-secrets, NOT SQAA.
        const globalBody = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();
        expect(globalBody).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(globalBody).not.toContain('# Vortex analysis');

        // SQAA is never written project-side on a global install.
        expect(harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).exists()).toBe(false);

        // Declarative state: prompt-secrets is global, Vortex is not recorded.
        expect(findCopilotFeature(harness, 'prompt-secrets-instructions')?.scope).toBe('global');
        expect(findCopilotFeature(harness, 'vortex')).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it(
      'omits the SQAA section when --project is not provided and no sonar-project.properties exists',
      async () => {
        const { extraEnv } = await setupCloudWithEntitlement();

        const result = await harness.run('integrate copilot --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        const body = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).not.toContain('# Vortex analysis');
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

        const result = await harness.run(
          `integrate copilot --project ${TEST_PROJECT} --non-interactive`,
          {
            extraEnv,
          },
        );

        expect(result.exitCode).toBe(0);
        const body = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).not.toContain('# Vortex analysis');
      },
      { timeout: 30000 },
    );

    it(
      'omits the SQAA section under -g when no project key is provided, even with an entitled org',
      async () => {
        const { extraEnv } = await setupCloudWithEntitlement();

        const result = await harness.run('integrate copilot -g --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        // Without a project key the SQAA section cannot bake one in, so the
        // section is skipped entirely — global file gets prompt-secrets only,
        // and no project-level file is written.
        const body = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).not.toContain('# Vortex analysis');
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(false);
        expect(findCopilotFeature(harness, 'vortex')).toBeUndefined();
        // Vortex is project-scoped, so a --global install skips it with the central
        // "not supported with --global" notice. It is never the missing-key
        // message, which is reserved for project installs that lack a key.
        const output = result.stdout + result.stderr;
        expect(output).toContain('not supported with --global');
        expect(output).not.toContain('a project key and organization are required');
      },
      { timeout: 30000 },
    );

    it(
      'omits the SQAA section when Server Vortex hubs are absent',
      async () => {
        // Default beforeEach is on-premise with no entitlement stubs, so both
        // hubs 404 and Vortex is not_applicable.
        const result = await harness.run(
          `integrate copilot --project ${TEST_PROJECT} --non-interactive`,
        );

        expect(result.exitCode).toBe(0);
        const body = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).not.toContain('# Vortex analysis');
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

        const result = await harness.run(
          `integrate copilot --project ${TEST_PROJECT} --non-interactive`,
          {
            extraEnv: {
              SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
              SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
            },
          },
        );

        // Command must not abort — degraded success.
        expect(result.exitCode).toBe(0);

        // Instructions file still written, but without the SQAA section.
        const body = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).not.toContain('# Vortex analysis');
      },
      { timeout: 30000 },
    );
  });

  // ─── Interactive feature selection ──────────────────────────────────────────
  //
  // Without --non-interactive each feature is gated by a prompt (ask) or an
  // automatic skip. InteractiveSession waits for each prompt, then enter()
  // accepts the default Yes and write('n') declines.

  describe('interactive feature selection', () => {
    it(
      'prompts per feature, installs accepted features, and shows the Vortex promotion when not entitled',
      async () => {
        // Default beforeEach is on-premise with no entitlement stubs, so Vortex
        // is not_applicable. The three remaining
        // features (hook, prompt-secrets, MCP) each ask.
        const session = harness.runInteractive('integrate copilot');
        await session.waitText('Where should SonarQube be integrated?');
        session.enter();
        await session.waitText('Install pre-tool-use hook?');
        session.enter();
        await session.waitText('Install prompt-secrets instructions?');
        session.enter();
        await session.waitText('Install MCP server?');
        session.enter();
        const result = await session.finish();

        expect(result.exitCode).toBe(0);
        const output = result.stdout + result.stderr;
        // Each opted feature surfaced its confirm prompt.
        expect(output).toContain('Install pre-tool-use hook?');
        expect(output).toContain('Install prompt-secrets instructions?');
        expect(output).toContain('Install MCP server?');
        expect(output).toContain('Vortex requires SonarQube Server 2026.5 Enterprise or later.');
        // Accepted features are installed on disk.
        expect(harness.cwd.file(...PROJECT_HOOK_SCRIPT_PATH).exists()).toBe(true);
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(true);
        expect(harness.cwd.exists('.mcp.json')).toBe(true);
        // No SQAA marker block was written (Server hubs absent).
        expect(harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText()).not.toContain(
          '# Vortex analysis',
        );
        // Declarative state records only the accepted features.
        expect(findCopilotFeature(harness, 'pre-tool-use-hook')).toBeDefined();
        expect(findCopilotFeature(harness, 'prompt-secrets-instructions')).toBeDefined();
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
      'prints a non-interactive hint with --non-interactive plus -p/-g examples only for a detected AI agent without --non-interactive (isAgent=%s, isInteractive=%s, expectedShownPrompt=%s)',
      async (isAgent, isInteractive, expectedShownPrompt) => {
        const extraEnv: Record<string, string> = isAgent ? { COPILOT_CLI: '1' } : {};
        let result: CliResult;
        if (isInteractive) {
          const session = harness.runInteractive('integrate copilot', { extraEnv });
          await session.waitText('Where should SonarQube be integrated?');
          session.enter();
          await session.waitText('Install pre-tool-use hook?');
          session.enter();
          await session.waitText('Install prompt-secrets instructions?');
          session.enter();
          await session.waitText('Install MCP server?');
          session.enter();
          result = await session.finish();
        } else {
          result = await harness.run('integrate copilot --non-interactive', { extraEnv });
        }

        expect(result.exitCode).toBe(0);
        if (expectedShownPrompt) {
          expectAgentPromptHint(
            result.stdout,
            'sonar integrate copilot --non-interactive',
            'sonar integrate copilot --non-interactive -g',
          );
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
        await session.waitText('Where should SonarQube be integrated?');
        session.enter();
        await session.waitText('Install pre-tool-use hook?');
        session.write('n');
        await session.waitText('Install prompt-secrets instructions?');
        session.enter();
        await session.waitText('Install MCP server?');
        session.enter();
        const result = await session.finish();

        expect(result.exitCode).toBe(0);
        // Hook was declined: no project-level hook artifacts and no state entry.
        expect(harness.cwd.exists('.github', 'hooks')).toBe(false);
        expect(findCopilotFeature(harness, 'pre-tool-use-hook')).toBeUndefined();
        // The accepted features are still installed.
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(true);
        expect(harness.cwd.exists('.mcp.json')).toBe(true);
        expect(findCopilotFeature(harness, 'prompt-secrets-instructions')).toBeDefined();
        expect(findCopilotFeature(harness, 'mcp-server')).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'auto-skips the hook (with message) and asks a custom question when a global hook and global instructions both exist',
      async () => {
        writeExistingGlobalHook(harness);
        writeExistingGlobalInstructions(harness);

        const session = harness.runInteractive('integrate copilot');
        await session.waitText('Where should SonarQube be integrated?');
        session.enter();
        await session.waitText(
          'Global Copilot instructions already exist. Do you also want to create a project-local copy for this repo?',
        );
        session.enter();
        await session.waitText('Install MCP server?');
        session.enter();
        const result = await session.finish();

        expect(result.exitCode).toBe(0);
        const output = result.stdout + result.stderr;
        // Hook: skipped with message, never prompted, nothing installed.
        expect(output).toContain(
          'Skipping the project-level pre-tool-use hook because a global secrets scanning hook is already configured.',
        );
        expect(output).not.toContain('Install pre-tool-use hook?');
        expect(harness.cwd.exists('.github', 'hooks')).toBe(false);
        expect(findCopilotFeature(harness, 'pre-tool-use-hook')).toBeUndefined();
        // prompt-secrets instructions: custom question.
        // accepting writes the project-local file.
        expect(output).toContain(
          'Global Copilot instructions already exist. Do you also want to create a project-local copy for this repo?',
        );
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(true);
        expect(findCopilotFeature(harness, 'prompt-secrets-instructions')?.scope).toBe('project');
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
});
