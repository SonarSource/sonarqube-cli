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
        expect(instructionsFile.asText()).toContain('# SonarQube prompt-secrets protocol');

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
        const instructionsLine = outcomeLine(result.stdout, 'Instructions:');
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
      'overwrites pre-existing global instructions and does not print the already-installed notice',
      async () => {
        // The existing-global short-circuit applies only to project scope, so
        // a global re-install must overwrite the file with real content.
        harness.userHome.writeFile(
          '.copilot/instructions/sonarqube.instructions.md',
          '# pre-existing\n',
        );

        const result = await harness.run('integrate copilot -g');

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText()).toContain(
          '# SonarQube prompt-secrets protocol',
        );
        expect(result.stdout).not.toContain(
          'Global prompt-secrets instructions already installed at',
        );
      },
      { timeout: 30000 },
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
        expect(normalizePath(outcomeLine(result.stdout, 'Instructions:'))).toContain(
          `${homePathNorm}/.copilot/instructions/sonarqube.instructions.md`,
        );
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

  // ─── Skip-on-existing-global instructions ───────────────────────────────────

  describe('project-level install when global Copilot instructions already exist', () => {
    it(
      'skips the project-level instructions write and does not record them in state',
      async () => {
        writeExistingGlobalInstructions(harness);
        const before = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Global prompt-secrets instructions already installed at');
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(false);
        expect(harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText()).toBe(before);
        expect(findSonarInstructionsExt(harness)).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it(
      'surfaces the pre-existing global instructions path on the outcome Instructions line',
      async () => {
        writeExistingGlobalInstructions(harness);

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        const homePathNorm = normalizePath(harness.userHome.path);
        const instructionsLine = normalizePath(outcomeLine(result.stdout, 'Instructions:'));
        // Outcome surfaces the existing global path, not a project path.
        expect(instructionsLine).toContain(
          `${homePathNorm}/.copilot/instructions/sonarqube.instructions.md`,
        );
        expect(instructionsLine).not.toContain('.github/instructions');
      },
      { timeout: 30000 },
    );
  });

  // ─── Skip-on-existing-global hook + instructions ────────────────────────────

  describe('project-level install when both global hook and global instructions already exist', () => {
    it(
      'skips both writes, records neither extension, and surfaces both global paths in the outcome',
      async () => {
        writeExistingGlobalHook(harness);
        writeExistingGlobalInstructions(harness);

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('.github', 'hooks')).toBe(false);
        expect(harness.cwd.exists('.github', 'instructions')).toBe(false);

        const state = harness.stateJsonFile.asJson();
        expect(state.agents?.['copilot-cli']?.configured).toBe(true);
        expect(findSonarHookExt(harness)).toBeUndefined();
        expect(findSonarInstructionsExt(harness)).toBeUndefined();

        const homePathNorm = normalizePath(harness.userHome.path);
        expect(normalizePath(outcomeLine(result.stdout, 'Hook:'))).toContain(
          `${homePathNorm}/.copilot/hooks/sonar-secrets`,
        );
        expect(normalizePath(outcomeLine(result.stdout, 'Instructions:'))).toContain(
          `${homePathNorm}/.copilot/instructions/sonarqube.instructions.md`,
        );
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
        expect(instructionsFile.asText()).toContain('# SonarQube prompt-secrets protocol');
        expect(findSonarInstructionsExt(harness)).toBeDefined();
        expect(outcomeLine(result.stdout, 'Instructions:')).not.toContain('not installed');

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
        expect(result.stderr + result.stdout).toContain(
          'Failed to install prompt-secrets instructions',
        );

        // Instructions registry entry must not be recorded.
        expect(findSonarInstructionsExt(harness)).toBeUndefined();
        expect(outcomeLine(result.stdout, 'Instructions:')).toContain(
          'not installed (see warning above)',
        );

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
        expect(result.stdout + result.stderr).toContain(
          '❌ Not authenticated. Run: sonar auth login',
        );
      },
      { timeout: 15000 },
    );
  });
});
