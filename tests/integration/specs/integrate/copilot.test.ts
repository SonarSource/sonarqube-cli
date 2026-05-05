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
import { hookScriptName, IS_WINDOWS, normalizePath, TestHarness } from '../../harness';

const HOOK_FIELD = IS_WINDOWS ? 'powershell' : 'bash';

interface CopilotHookEntry {
  type: 'command';
  bash?: string;
  powershell?: string;
  timeoutSec?: number;
}

interface CopilotHooksJson {
  version: number;
  hooks: { preToolUse?: CopilotHookEntry[] };
}

interface McpJson {
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

describe('integrate copilot', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  // ─── Project-level install (default) ────────────────────────────────────────

  describe('project-level install (default)', () => {
    it(
      'writes the pretool-secrets script and hooks.json under .github/hooks/',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        expect(
          harness.cwd.exists(
            '.github',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            hookScriptName('pretool-secrets'),
          ),
        ).toBe(true);
        expect(harness.cwd.exists('.github', 'hooks', 'hooks.json')).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'writes a relative-path preToolUse entry in hooks.json with timeoutSec=60',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        await harness.run('integrate copilot');

        const json: CopilotHooksJson = harness.cwd.file('.github', 'hooks', 'hooks.json').asJson();
        expect(json.hooks.preToolUse).toHaveLength(1);
        const entry = json.hooks.preToolUse?.[0] ?? ({} as CopilotHookEntry);
        expect(entry.type).toBe('command');
        expect(entry.timeoutSec).toBe(60);
        const command = entry[HOOK_FIELD] ?? '';
        expect(command.length).toBeGreaterThan(0);
        // Project scope uses paths relative to the hooks dir.
        expect(command.startsWith('/')).toBe(false);
        expect(command).toContain('sonar-secrets');
        expect(command).toContain(`pretool-secrets`);
      },
      { timeout: 30000 },
    );

    it(
      'writes the prompt-secrets instructions file under .github/instructions/',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        await harness.run('integrate copilot');

        expect(harness.cwd.exists('.github', 'instructions', 'sonarqube.instructions.md')).toBe(
          true,
        );
        const body = harness.cwd
          .file('.github', 'instructions', 'sonarqube.instructions.md')
          .asText();
        expect(body).toContain('# SonarQube prompt-secrets protocol');
      },
      { timeout: 30000 },
    );

    it(
      'writes .mcp.json with a sonarqube entry using the platform CLI command',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        await harness.run('integrate copilot');

        expect(harness.cwd.exists('.mcp.json')).toBe(true);
        const mcp: McpJson = harness.cwd.file('.mcp.json').asJson();
        const sonar = mcp.mcpServers?.sonarqube;
        expect(sonar).toBeDefined();
        expect(sonar?.command).toBe(CLI_COMMAND);
        expect(sonar?.args?.slice(0, 2)).toEqual(['run', 'mcp']);
      },
      { timeout: 30000 },
    );

    it(
      'does not touch ~/.copilot when running without --global',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        await harness.run('integrate copilot');

        expect(harness.userHome.exists('.copilot')).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'records sonar-secrets hook + sonar-prompt-secrets instructions in agentExtensions',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        await harness.run('integrate copilot');

        const state = harness.stateJsonFile.asJson();
        expect(state.agents?.['copilot-cli']?.configured).toBe(true);

        const exts = (state.agentExtensions ?? []) as Array<{
          kind: string;
          name: string;
          hookType?: string;
        }>;
        const hook = exts.find(
          (e) => e.kind === 'hook' && e.name === 'sonar-secrets' && e.hookType === 'PreToolUse',
        );
        const instr = exts.find(
          (e) => e.kind === 'instructions' && e.name === 'sonar-prompt-secrets',
        );
        expect(hook).toBeDefined();
        expect(instr).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'is idempotent — running integrate copilot twice yields one preToolUse entry in hooks.json',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        await harness.run('integrate copilot');
        await harness.run('integrate copilot');

        const json: CopilotHooksJson = harness.cwd.file('.github', 'hooks', 'hooks.json').asJson();
        expect(json.hooks.preToolUse).toHaveLength(1);
      },
      { timeout: 60000 },
    );

    it(
      'appends --project <key> to the MCP server args when --project is provided',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

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
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        await harness.run('integrate copilot');

        const content = harness.cwd
          .file(
            '.github',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            hookScriptName('pretool-secrets'),
          )
          .asText();
        expect(content).toContain('sonar hook copilot-pre-tool-use');
        expect(content).not.toContain('sonar analyze');
      },
      { timeout: 30000 },
    );

    it(
      'pretool-secrets script is executable after integration',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        await harness.run('integrate copilot');

        const scriptFile = harness.cwd.file(
          '.github',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        );
        expect(scriptFile.exists()).toBe(true);
        expect(scriptFile.isExecutable).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'preserves unrelated preToolUse entries in a pre-existing project hooks.json',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        const unrelatedEntry: CopilotHookEntry = { type: 'command', timeoutSec: 30 };
        unrelatedEntry[HOOK_FIELD] = '/other/tool/run.sh';
        harness.cwd.writeFile(
          '.github/hooks/hooks.json',
          JSON.stringify({ version: 1, hooks: { preToolUse: [unrelatedEntry] } }),
        );

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        const json: CopilotHooksJson = harness.cwd.file('.github', 'hooks', 'hooks.json').asJson();
        const entries = json.hooks.preToolUse ?? [];
        expect(entries).toHaveLength(2);
        const unrelated = entries.find((e) => (e[HOOK_FIELD] ?? '').includes('/other/tool/'));
        const sonar = entries.find((e) => (e[HOOK_FIELD] ?? '').includes('sonar-secrets'));
        expect(unrelated).toBeDefined();
        expect(sonar).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'initialises the hooks key when a pre-existing hooks.json lacks it',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        // Bare hooks.json with no top-level `hooks` key. The install must
        // initialise `hooks` (via `hooksJson.hooks ??= {}`) without crashing
        // and without dropping the existing `version` field.
        harness.cwd.writeFile('.github/hooks/hooks.json', JSON.stringify({ version: 1 }));

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        const json: CopilotHooksJson = harness.cwd.file('.github', 'hooks', 'hooks.json').asJson();
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
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(
          'Copilot integration successfully configured at the project level',
        );
        const hookLine = result.stdout.split('\n').find((line) => line.startsWith('Hook:'));
        expect(hookLine).toBeDefined();
        expect(hookLine).toContain('sonar-secrets');
        expect(hookLine).toContain('pretool-secrets');
        const instructionsLine = result.stdout
          .split('\n')
          .find((line) => line.startsWith('Instructions:'));
        expect(instructionsLine).toBeDefined();
        expect(instructionsLine).toContain('sonarqube.instructions.md');
        expect(normalizePath(instructionsLine ?? '')).toContain('.github/instructions');
      },
      { timeout: 30000 },
    );
  });

  // ─── Global install (-g) ────────────────────────────────────────────────────

  describe('global install (-g)', () => {
    it(
      'writes hook script, hooks.json, instructions, and mcp-config.json under ~/.copilot/',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        const result = await harness.run('integrate copilot -g');

        expect(result.exitCode).toBe(0);
        expect(
          harness.userHome.exists(
            '.copilot',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            hookScriptName('pretool-secrets'),
          ),
        ).toBe(true);
        expect(harness.userHome.exists('.copilot', 'hooks', 'hooks.json')).toBe(true);
        expect(
          harness.userHome.exists('.copilot', 'instructions', 'sonarqube.instructions.md'),
        ).toBe(true);
        expect(harness.userHome.exists('.copilot', 'mcp-config.json')).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'uses an absolute path in the hooks.json preToolUse entry under ~/.copilot/hooks/',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        await harness.run('integrate copilot -g');

        const json: CopilotHooksJson = harness.userHome
          .file('.copilot', 'hooks', 'hooks.json')
          .asJson();
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
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

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
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        await harness.run('integrate copilot -g');

        const state = harness.stateJsonFile.asJson();
        const exts = (state.agentExtensions ?? []) as Array<{
          kind: string;
          name: string;
          global: boolean;
        }>;
        const hook = exts.find((e) => e.kind === 'hook' && e.name === 'sonar-secrets');
        const instr = exts.find(
          (e) => e.kind === 'instructions' && e.name === 'sonar-prompt-secrets',
        );
        expect(hook?.global).toBe(true);
        expect(instr?.global).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'overwrites pre-existing global instructions and does not print the already-installed notice',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');
        // Seed a sentinel file at the global instructions path. The
        // existing-global short-circuit applies only to project scope, so a
        // global re-install must overwrite the file with real content.
        harness.userHome.writeFile(
          '.copilot/instructions/sonarqube.instructions.md',
          '# pre-existing\n',
        );

        const result = await harness.run('integrate copilot -g');

        expect(result.exitCode).toBe(0);
        const body = harness.userHome
          .file('.copilot', 'instructions', 'sonarqube.instructions.md')
          .asText();
        expect(body).toContain('# SonarQube prompt-secrets protocol');
        expect(result.stdout).not.toContain(
          'Global prompt-secrets instructions already installed at',
        );
      },
      { timeout: 30000 },
    );

    it(
      'prints a global outcome message with the written hook and instructions paths under ~/.copilot/',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        const result = await harness.run('integrate copilot -g');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Copilot integration successfully configured globally');
        const homePathNorm = normalizePath(harness.userHome.path);
        const hookLine = result.stdout.split('\n').find((line) => line.startsWith('Hook:'));
        expect(hookLine).toBeDefined();
        expect(normalizePath(hookLine ?? '')).toContain(
          `${homePathNorm}/.copilot/hooks/sonar-secrets`,
        );
        const instructionsLine = result.stdout
          .split('\n')
          .find((line) => line.startsWith('Instructions:'));
        expect(instructionsLine).toBeDefined();
        expect(normalizePath(instructionsLine ?? '')).toContain(
          `${homePathNorm}/.copilot/instructions/sonarqube.instructions.md`,
        );
      },
      { timeout: 30000 },
    );
  });

  // ─── Skip-on-existing-global ────────────────────────────────────────────────

  function writeExistingGlobalHook(): void {
    // Simulate a previous `sonar integrate copilot -g` run on disk.
    const scriptRel = `.copilot/hooks/sonar-secrets/build-scripts/${hookScriptName('pretool-secrets')}`;
    harness.userHome.writeFile(scriptRel, '#!/bin/bash\nexit 0\n');
    const absScriptPath = harness.userHome.file(scriptRel).path;
    const entry: CopilotHookEntry = { type: 'command', timeoutSec: 60 };
    entry[HOOK_FIELD] = normalizePath(absScriptPath);
    const hooksJson: CopilotHooksJson = {
      version: 1,
      hooks: { preToolUse: [entry] },
    };
    harness.userHome.writeFile('.copilot/hooks/hooks.json', JSON.stringify(hooksJson));
  }

  describe('project-level install when a global Copilot hook already exists', () => {
    it(
      'skips the project-level hook write and prints the "already configured" notice',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');
        writeExistingGlobalHook();

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
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');
        writeExistingGlobalHook();

        await harness.run('integrate copilot');

        const state = harness.stateJsonFile.asJson();
        const exts = (state.agentExtensions ?? []) as Array<{ kind: string; name: string }>;
        const hook = exts.find((e) => e.kind === 'hook' && e.name === 'sonar-secrets');
        expect(hook).toBeUndefined();
        // Instructions are independent — the project-level instructions
        // write still runs because the global instructions file does not exist.
        const instr = exts.find(
          (e) => e.kind === 'instructions' && e.name === 'sonar-prompt-secrets',
        );
        expect(instr).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'leaves the pre-existing global hooks.json byte-identical',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');
        writeExistingGlobalHook();
        const before = harness.userHome.file('.copilot', 'hooks', 'hooks.json').asText();

        await harness.run('integrate copilot');

        const after = harness.userHome.file('.copilot', 'hooks', 'hooks.json').asText();
        expect(after).toBe(before);
      },
      { timeout: 30000 },
    );

    it(
      'falls back to a project-level install (and warns) when the referenced global script is missing (orphaned)',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');
        // Write hooks.json that references a sonar-secrets script that does not exist on disk.
        const orphanScript = harness.userHome.file(
          `.copilot/hooks/sonar-secrets/build-scripts/${hookScriptName('pretool-secrets')}`,
        ).path;
        const entry: CopilotHookEntry = { type: 'command', timeoutSec: 60 };
        entry[HOOK_FIELD] = normalizePath(orphanScript);
        const orphanedJson: CopilotHooksJson = {
          version: 1,
          hooks: { preToolUse: [entry] },
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
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        // The marker check matches sonar-secrets entries by path substring;
        // an unrelated tool's entry must not short-circuit our install.
        const unrelatedEntry: CopilotHookEntry = { type: 'command', timeoutSec: 30 };
        unrelatedEntry[HOOK_FIELD] = '/some/other-tool/script.sh';
        const globalJson: CopilotHooksJson = {
          version: 1,
          hooks: { preToolUse: [unrelatedEntry] },
        };
        harness.userHome.writeFile('.copilot/hooks/hooks.json', JSON.stringify(globalJson));
        const before = harness.userHome.file('.copilot', 'hooks', 'hooks.json').asText();

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        // Project install proceeded.
        expect(harness.cwd.exists('.github', 'hooks', 'hooks.json')).toBe(true);
        const projectJson: CopilotHooksJson = harness.cwd
          .file('.github', 'hooks', 'hooks.json')
          .asJson();
        const projectEntries = projectJson.hooks.preToolUse ?? [];
        expect(projectEntries.some((e) => (e[HOOK_FIELD] ?? '').includes('sonar-secrets'))).toBe(
          true,
        );
        // No "already configured" notice was emitted.
        expect(result.stdout).not.toContain('A global secrets scanning hook is already configured');
        // Global hooks.json was not touched.
        const after = harness.userHome.file('.copilot', 'hooks', 'hooks.json').asText();
        expect(after).toBe(before);
      },
      { timeout: 30000 },
    );
  });

  describe('project-level install when global Copilot instructions already exist', () => {
    it(
      'skips the project-level instructions write and does not record them in state',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');
        harness.userHome.writeFile(
          '.copilot/instructions/sonarqube.instructions.md',
          '# pre-existing global instructions\n',
        );
        const before = harness.userHome
          .file('.copilot', 'instructions', 'sonarqube.instructions.md')
          .asText();

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Global prompt-secrets instructions already installed at');
        expect(harness.cwd.exists('.github', 'instructions', 'sonarqube.instructions.md')).toBe(
          false,
        );
        const after = harness.userHome
          .file('.copilot', 'instructions', 'sonarqube.instructions.md')
          .asText();
        expect(after).toBe(before);

        const state = harness.stateJsonFile.asJson();
        const exts = (state.agentExtensions ?? []) as Array<{ kind: string; name: string }>;
        const instr = exts.find(
          (e) => e.kind === 'instructions' && e.name === 'sonar-prompt-secrets',
        );
        expect(instr).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it(
      'surfaces the pre-existing global instructions path on the outcome Instructions line',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');
        harness.userHome.writeFile(
          '.copilot/instructions/sonarqube.instructions.md',
          '# pre-existing global instructions\n',
        );

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        const homePathNorm = normalizePath(harness.userHome.path);
        const instructionsLine = result.stdout
          .split('\n')
          .find((line) => line.startsWith('Instructions:'));
        expect(instructionsLine).toBeDefined();
        // Outcome surfaces the existing global path, not a project path.
        expect(normalizePath(instructionsLine ?? '')).toContain(
          `${homePathNorm}/.copilot/instructions/sonarqube.instructions.md`,
        );
        expect(normalizePath(instructionsLine ?? '')).not.toContain('.github/instructions');
      },
      { timeout: 30000 },
    );
  });

  describe('project-level install when both global hook and global instructions already exist', () => {
    it(
      'skips both project-level writes, records neither extension, and surfaces both global paths in the outcome message',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');
        writeExistingGlobalHook();
        harness.userHome.writeFile(
          '.copilot/instructions/sonarqube.instructions.md',
          '# pre-existing global instructions\n',
        );

        const result = await harness.run('integrate copilot');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('.github', 'hooks')).toBe(false);
        expect(harness.cwd.exists('.github', 'instructions')).toBe(false);

        const state = harness.stateJsonFile.asJson();
        expect(state.agents?.['copilot-cli']?.configured).toBe(true);
        const exts = (state.agentExtensions ?? []) as Array<{ kind: string; name: string }>;
        expect(exts.find((e) => e.kind === 'hook' && e.name === 'sonar-secrets')).toBeUndefined();
        expect(
          exts.find((e) => e.kind === 'instructions' && e.name === 'sonar-prompt-secrets'),
        ).toBeUndefined();

        // Outcome line surfaces the pre-existing global paths (not project paths).
        const homePathNorm = normalizePath(harness.userHome.path);
        const hookLine = result.stdout.split('\n').find((line) => line.startsWith('Hook:'));
        expect(hookLine).toBeDefined();
        expect(normalizePath(hookLine ?? '')).toContain(
          `${homePathNorm}/.copilot/hooks/sonar-secrets`,
        );
        const instructionsLine = result.stdout
          .split('\n')
          .find((line) => line.startsWith('Instructions:'));
        expect(instructionsLine).toBeDefined();
        expect(normalizePath(instructionsLine ?? '')).toContain(
          `${homePathNorm}/.copilot/instructions/sonarqube.instructions.md`,
        );
      },
      { timeout: 30000 },
    );
  });

  // ─── Option validation ──────────────────────────────────────────────────────

  describe('option validation', () => {
    it(
      'exits with code 1 when both --global and --project are provided',
      async () => {
        const server = await harness.newFakeServer().withAuthToken('tok').start();
        harness.withAuth(server.baseUrl(), 'tok');

        const result = await harness.run('integrate copilot --global --project foo');

        expect(result.exitCode).toBe(1);
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
