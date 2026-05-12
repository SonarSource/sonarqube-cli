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

import { CLI_COMMAND } from '../../../../src/lib/config-constants.js';
import { normalizePath, TestHarness } from '../../harness';
import {
  CopilotHookEntry,
  CopilotHooksJson,
  findSonarHookExt,
  findSonarInstructionsExt,
  findSonarSqaaInstructionsExt,
  GLOBAL_HOOK_SCRIPT_PATH,
  GLOBAL_HOOKS_JSON_PATH,
  GLOBAL_INSTRUCTIONS_PATH,
  HOOK_FIELD,
  makeHookEntry,
  McpJson,
  obstructHooksJson,
  obstructInstructionsFile,
  outcomeLine,
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
        const result = await harness.run('integrate copilot');

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
        // the platform CLI command.
        expect(harness.cwd.exists('.mcp.json')).toBe(true);
        const mcp: McpJson = harness.cwd.file('.mcp.json').asJson();
        const sonar = mcp.mcpServers?.sonarqube;
        expect(sonar?.command).toBe(CLI_COMMAND);
        expect(sonar?.args?.slice(0, 2)).toEqual(['run', 'mcp']);
      },
      { timeout: 30000 },
    );

    it(
      'writes a relative-path preToolUse entry in hooks.json with timeoutSec=60',
      async () => {
        await harness.run('integrate copilot');

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
        await harness.run('integrate copilot');

        expect(harness.userHome.exists('.copilot')).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'records sonar-secrets hook + sonar-prompt-secrets instructions in agentExtensions',
      async () => {
        await harness.run('integrate copilot');

        const state = harness.stateJsonFile.asJson();
        expect(state.agents?.['copilot-cli']?.configured).toBe(true);

        const hook = findSonarHookExt(harness);
        expect(hook).toBeDefined();
        expect(hook?.hookType).toBe('PreToolUse');
        expect(findSonarInstructionsExt(harness)).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'running twice yields exactly one preToolUse entry in hooks.json',
      async () => {
        await harness.run('integrate copilot');
        await harness.run('integrate copilot');

        const json = harness.cwd.file(...PROJECT_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        expect(json.hooks.preToolUse).toHaveLength(1);
      },
      { timeout: 60000 },
    );

    it(
      'appends --project <key> to the MCP server args when --project is provided',
      async () => {
        await harness.run('integrate copilot --project my-project');

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
        await harness.run('integrate copilot');

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

        const result = await harness.run('integrate copilot');

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

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        const json = harness.cwd.file(...PROJECT_HOOKS_JSON_PATH).asJson() as CopilotHooksJson;
        expect(json.version).toBe(1);
        const entries = json.hooks.preToolUse ?? [];
        expect(entries).toHaveLength(1);
        expect(entries[0][HOOK_FIELD] ?? '').toContain('sonar-secrets');
      },
      { timeout: 30000 },
    );

    it(
      'prints a project-level outcome message with the written hook and instructions paths',
      async () => {
        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(
          'Copilot integration successfully configured at the project level',
        );
        const hookLine = outcomeLine(result.stdout, 'Hook:');
        expect(hookLine).toContain('sonar-secrets');
        expect(hookLine).toContain('pretool-secrets');
        const instructionsLine = outcomeLine(
          result.stdout,
          'Instructions (secrets scanning for prompts):',
        );
        expect(instructionsLine).toContain('sonarqube.instructions.md');
        expect(normalizePath(instructionsLine)).toContain('.github/instructions');
      },
      { timeout: 30000 },
    );
  });

  // ─── Global install (-g) ────────────────────────────────────────────────────

  describe('global install (-g)', () => {
    it(
      'writes hook script, hooks.json, instructions, and mcp-config.json under ~/.copilot/',
      async () => {
        const result = await harness.run('integrate copilot -g');

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
        await harness.run('integrate copilot -g');

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
        await harness.run('integrate copilot -g');

        expect(harness.cwd.exists('.github', 'hooks')).toBe(false);
        expect(harness.cwd.exists('.github', 'instructions')).toBe(false);
        expect(harness.cwd.exists('.mcp.json')).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'records both extensions as global=true in state',
      async () => {
        await harness.run('integrate copilot -g');

        expect(findSonarHookExt(harness)?.global).toBe(true);
        expect(findSonarInstructionsExt(harness)?.global).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'overwrites pre-existing global instructions (CLI-owned file)',
      async () => {
        // sonarqube.instructions.md is CLI-owned, so any pre-existing content
        // is replaced with the freshly rendered prompt-secrets section.
        harness.userHome.writeFile(
          '.copilot/instructions/sonarqube.instructions.md',
          '# pre-existing\n',
        );

        const result = await harness.run('integrate copilot -g');

        expect(result.exitCode).toBe(0);
        const body = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();
        expect(body).not.toContain('# pre-existing');
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
      },
      { timeout: 30000 },
    );

    it(
      'is idempotent: running -g twice yields exactly one prompt-secrets section',
      async () => {
        await harness.run('integrate copilot -g');
        await harness.run('integrate copilot -g');

        const body = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();
        const headingCount =
          body.split('# SonarQube secrets scanning for prompts protocol').length - 1;
        expect(headingCount).toBe(1);
      },
      { timeout: 60000 },
    );

    it(
      'prints a global outcome message with the written hook and instructions paths under ~/.copilot/',
      async () => {
        const result = await harness.run('integrate copilot -g');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Copilot integration successfully configured globally');
        const homePathNorm = normalizePath(harness.userHome.path);
        expect(normalizePath(outcomeLine(result.stdout, 'Hook:'))).toContain(
          `${homePathNorm}/.copilot/hooks/sonar-secrets`,
        );
        expect(
          normalizePath(outcomeLine(result.stdout, 'Instructions (secrets scanning for prompts):')),
        ).toContain(`${homePathNorm}/.copilot/instructions/sonarqube.instructions.md`);
      },
      { timeout: 30000 },
    );
  });

  // ─── Skip-on-existing-global hook ───────────────────────────────────────────

  describe('project-level install when a global Copilot hook already exists', () => {
    it(
      'skips the project-level hook write and prints the "already configured" notice',
      async () => {
        writeExistingGlobalHook(harness);

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('.github', 'hooks', 'sonar-secrets')).toBe(false);
        expect(harness.cwd.exists('.github', 'hooks', 'hooks.json')).toBe(false);
        expect(result.stdout).toContain('A global secrets scanning hook is already configured at');
      },
      { timeout: 30000 },
    );

    it(
      'does not record the sonar-secrets hook in state when the project-level write was skipped',
      async () => {
        writeExistingGlobalHook(harness);

        await harness.run('integrate copilot');

        expect(findSonarHookExt(harness)).toBeUndefined();
        // Instructions are independent — the project-level instructions
        // write still runs because the global instructions file does not exist.
        expect(findSonarInstructionsExt(harness)).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'leaves the pre-existing global hooks.json byte-identical',
      async () => {
        writeExistingGlobalHook(harness);
        const before = harness.userHome.file(...GLOBAL_HOOKS_JSON_PATH).asText();

        await harness.run('integrate copilot');

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

        const result = await harness.run('integrate copilot');

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

        const result = await harness.run('integrate copilot');

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
      'writes the project-level instructions file, leaves the global file untouched, and warns about it',
      async () => {
        writeExistingGlobalInstructions(harness);
        const before = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        // Project file is written despite the global file existing.
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(true);
        expect(harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText()).toContain(
          '# SonarQube secrets scanning for prompts protocol',
        );
        // Global file is byte-identical (orphan; not touched).
        expect(harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText()).toBe(before);
        // State records the project-scoped prompt-secrets entry.
        expect(findSonarInstructionsExt(harness)?.global).toBe(false);
        // Orphan warning surfaces the stale global file path.
        expect(result.stderr + result.stdout).toContain('Found existing Copilot instructions at');
        expect(normalizePath(result.stderr + result.stdout)).toContain(
          '.copilot/instructions/sonarqube.instructions.md',
        );
      },
      { timeout: 30000 },
    );

    it(
      'surfaces the project-level instructions path on the outcome Instructions line',
      async () => {
        writeExistingGlobalInstructions(harness);

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        const instructionsLine = normalizePath(
          outcomeLine(result.stdout, 'Instructions (secrets scanning for prompts):'),
        );
        expect(instructionsLine).toContain('.github/instructions/sonarqube.instructions.md');
        expect(instructionsLine).not.toContain('.copilot/instructions');
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

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        // Hook is short-circuited; no project-level hook artifacts.
        expect(harness.cwd.exists('.github', 'hooks')).toBe(false);
        // Instructions are independent — the project-level file is written.
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(true);

        const state = harness.stateJsonFile.asJson();
        expect(state.agents?.['copilot-cli']?.configured).toBe(true);
        expect(findSonarHookExt(harness)).toBeUndefined();
        expect(findSonarInstructionsExt(harness)?.global).toBe(false);

        const homePathNorm = normalizePath(harness.userHome.path);
        expect(normalizePath(outcomeLine(result.stdout, 'Hook:'))).toContain(
          `${homePathNorm}/.copilot/hooks/sonar-secrets`,
        );
        expect(
          normalizePath(outcomeLine(result.stdout, 'Instructions (secrets scanning for prompts):')),
        ).toContain('.github/instructions/sonarqube.instructions.md');
      },
      { timeout: 30000 },
    );
  });

  // ─── Installation failure handling ──────────────────────────────────────────

  // We force file-system failures by pre-creating the would-be artifact paths
  // as directories. The integration's `writeFile`/`readFile` calls then fail,
  // exercising the try/catch fallbacks.

  describe('installation failure handling', () => {
    it(
      'warns and continues with MCP + instructions when the hook write fails',
      async () => {
        obstructHooksJson(harness);

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        expect(result.stderr + result.stdout).toContain(
          'Failed to set up the pre-tool-use secrets hook',
        );

        // Hook artifact was not finalized; the registry must not claim it was.
        expect(findSonarHookExt(harness)).toBeUndefined();
        // Outcome line reflects the failure rather than printing a misleading path.
        expect(outcomeLine(result.stdout, 'Hook:')).toContain('not installed (see warning above)');

        // Instructions still installed.
        const instructionsFile = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH);
        expect(instructionsFile.exists()).toBe(true);
        expect(instructionsFile.asText()).toContain(
          '# SonarQube secrets scanning for prompts protocol',
        );
        expect(findSonarInstructionsExt(harness)).toBeDefined();
        expect(
          outcomeLine(result.stdout, 'Instructions (secrets scanning for prompts):'),
        ).not.toContain('not installed');

        // MCP still configured.
        expect(harness.cwd.exists('.mcp.json')).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'warns and continues with MCP + hook when the instructions write fails',
      async () => {
        obstructInstructionsFile(harness);

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        expect(result.stderr + result.stdout).toContain('Failed to install Copilot instructions');

        // Instructions registry entry must not be recorded.
        expect(findSonarInstructionsExt(harness)).toBeUndefined();
        expect(
          outcomeLine(result.stdout, 'Instructions (secrets scanning for prompts):'),
        ).toContain('not installed (see warning above)');

        // Hook still installed.
        const scriptFile = harness.cwd.file(...PROJECT_HOOK_SCRIPT_PATH);
        expect(scriptFile.exists()).toBe(true);
        expect(findSonarHookExt(harness)).toBeDefined();
        expect(outcomeLine(result.stdout, 'Hook:')).not.toContain('not installed');

        // MCP still configured.
        expect(harness.cwd.exists('.mcp.json')).toBe(true);
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
     * Stand up a fake SonarQube Cloud server with SQAA entitlement configured
     * for the test org, swap the harness auth to a cloud connection, and
     * return env vars that point the CLI's hard-coded SonarCloud URL
     * constants at the fake server (so `isSonarQubeCloud(serverUrl)` and the
     * entitlement endpoint both resolve to the fake).
     */
    async function setupCloudWithEntitlement(
      options: { eligible?: boolean; enabled?: boolean } = {},
    ): Promise<{ extraEnv: Record<string, string> }> {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
        .withSqaaEntitlement(TEST_ORG, 'test-uuid-1234', options)
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
      'merges the SQAA section into the project file when org is entitled, project scope, and project key is provided',
      async () => {
        const { extraEnv } = await setupCloudWithEntitlement();

        const result = await harness.run(`integrate copilot --project ${TEST_PROJECT}`, {
          extraEnv,
        });

        expect(result.exitCode).toBe(0);
        const body = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).toContain('# SonarQube Agentic Analysis protocol');
        // Project key is baked into the example command.
        expect(body).toContain(`sonar analyze agentic --project ${TEST_PROJECT} --file`);

        // Both sections recorded in state with the SQAA entry carrying the cloud attrs.
        const promptSecrets = findSonarInstructionsExt(harness);
        expect(promptSecrets?.global).toBe(false);
        const sqaa = findSonarSqaaInstructionsExt(harness);
        expect(sqaa?.global).toBe(false);
        expect(sqaa?.projectKey).toBe(TEST_PROJECT);
        expect(sqaa?.orgKey).toBe(TEST_ORG);
      },
      { timeout: 30000 },
    );

    it(
      'writes the SQAA section to the project file under -g when org is entitled and a project key is discoverable from sonar-project.properties',
      async () => {
        // `--global` and `--project` are mutually exclusive on the CLI, so the
        // project key must be discovered from disk in the global flow.
        const { extraEnv } = await setupCloudWithEntitlement();
        harness.cwd.writeFile('sonar-project.properties', `sonar.projectKey=${TEST_PROJECT}\n`);

        const result = await harness.run('integrate copilot -g', { extraEnv });

        expect(result.exitCode).toBe(0);

        // Global file holds prompt-secrets, NOT SQAA.
        const globalBody = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();
        expect(globalBody).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(globalBody).not.toContain('# SonarQube Agentic Analysis');

        // Project file holds SQAA, NOT prompt-secrets.
        const projectBody = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        expect(projectBody).toContain('# SonarQube Agentic Analysis protocol');
        expect(projectBody).toContain(`sonar analyze agentic --project ${TEST_PROJECT} --file`);
        expect(projectBody).not.toContain('# SonarQube secrets scanning for prompts protocol');

        // State: prompt-secrets is global, SQAA is project-scoped.
        expect(findSonarInstructionsExt(harness)?.global).toBe(true);
        expect(findSonarSqaaInstructionsExt(harness)?.global).toBe(false);

        // Outcome shows both labeled lines pointing to their respective files.
        const homePathNorm = normalizePath(harness.userHome.path);
        expect(
          normalizePath(outcomeLine(result.stdout, 'Instructions (secrets scanning for prompts):')),
        ).toContain(`${homePathNorm}/.copilot/instructions/sonarqube.instructions.md`);
        expect(
          normalizePath(outcomeLine(result.stdout, 'Instructions (SonarQube Agentic Analysis):')),
        ).toContain('.github/instructions/sonarqube.instructions.md');
      },
      { timeout: 30000 },
    );

    it(
      'omits the SQAA section when --project is not provided and no sonar-project.properties exists',
      async () => {
        const { extraEnv } = await setupCloudWithEntitlement();

        const result = await harness.run('integrate copilot', { extraEnv });

        expect(result.exitCode).toBe(0);
        const body = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).not.toContain('# SonarQube Agentic Analysis');
      },
      { timeout: 30000 },
    );

    it(
      'omits the SQAA section when the org is not entitled to SQAA',
      async () => {
        const { extraEnv } = await setupCloudWithEntitlement({
          eligible: false,
          enabled: false,
        });

        const result = await harness.run(`integrate copilot --project ${TEST_PROJECT}`, {
          extraEnv,
        });

        expect(result.exitCode).toBe(0);
        const body = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).not.toContain('# SonarQube Agentic Analysis');
      },
      { timeout: 30000 },
    );

    it(
      'omits the SQAA section under -g when no project key is provided, even with an entitled org',
      async () => {
        const { extraEnv } = await setupCloudWithEntitlement();

        const result = await harness.run('integrate copilot -g', { extraEnv });

        expect(result.exitCode).toBe(0);
        // Without a project key the SQAA section cannot bake one in, so the
        // section is skipped entirely — global file gets prompt-secrets only,
        // and no project-level file is written.
        const body = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).not.toContain('# SonarQube Agentic Analysis');
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(false);
        expect(findSonarSqaaInstructionsExt(harness)).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it(
      'omits the SQAA section on on-premise (no organization on the auth)',
      async () => {
        // Default beforeEach sets up on-premise auth (no org). hasSqaaEntitlement
        // returns false fast without hitting the API in this case.
        const result = await harness.run(`integrate copilot --project ${TEST_PROJECT}`);

        expect(result.exitCode).toBe(0);
        const body = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).not.toContain('# SonarQube Agentic Analysis');
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

        const result = await harness.run(`integrate copilot --project ${TEST_PROJECT}`, {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        });

        // Command must not abort — degraded success.
        expect(result.exitCode).toBe(0);

        // Instructions file still written, but without the SQAA section.
        const body = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
        expect(body).not.toContain('# SonarQube Agentic Analysis');
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

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('❌ Not authenticated.');
        expect(output).toContain("💡 Run 'sonar auth login' to authenticate.");
      },
      { timeout: 15000 },
    );
  });
});
