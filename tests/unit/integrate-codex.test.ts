/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Unit tests for CLI command: `sonar integrate codex` (see command-tree.ts → integrate codex).

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  hasSonarqubeMcpBlockInToml,
  mergeCodexHooksFeatureProjectLayerIfPresent,
  mergeFeaturesCodexHooks,
  stripMcpServersSonarqubeBlock,
  writeCodexTomlIntegration,
} from '../../src/cli/commands/integrate/codex/codex-config';
import {
  getCodexSecretPreToolTemplateUnix,
  getCodexSecretPromptTemplateUnix,
  getCodexSqaaPostToolTemplateUnix,
} from '../../src/cli/commands/integrate/codex/hook-templates';
import {
  installCodexHooks,
  isCodexHooksSupportedOnPlatform,
} from '../../src/cli/commands/integrate/codex/hooks';
import type { ResolvedAuth } from '../../src/lib/auth-resolver';
import { codexHooksJsonPath } from '../../src/lib/config-constants';
import { updateStateAfterCodexConfiguration } from '../../src/cli/commands/integrate/codex/state';
import type { ConfigurationData } from '../../src/cli/commands/integrate/_common/integrate-configuration';
import { getDefaultState } from '../../src/lib/state';
import * as stateManager from '../../src/lib/state-manager';

describe('sonar integrate codex', () => {
  const decodeSpawnOutput = (output: ArrayBufferView | null | undefined): string =>
    output
      ? Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString('utf-8')
      : '';

  describe('stripMcpServersSonarqubeBlock', () => {
    it('removes mcp_servers.sonarqube and .env sections', () => {
      const input = `[other]
key = "v"

[mcp_servers.sonarqube]
command = "old"

[mcp_servers.sonarqube.env]
X = "y"

[features]
x = 1
`;
      const out = stripMcpServersSonarqubeBlock(input);
      expect(out).toContain('[other]');
      expect(out).not.toContain('mcp_servers.sonarqube');
      expect(out).toContain('[features]');
    });
  });

  describe('hasSonarqubeMcpBlockInToml', () => {
    it('is true when [mcp_servers.sonarqube] header exists', () => {
      expect(hasSonarqubeMcpBlockInToml('[mcp_servers.sonarqube]\ncommand = "docker"\n')).toBe(
        true,
      );
    });

    it('is false when section is missing', () => {
      expect(hasSonarqubeMcpBlockInToml('[mcp_servers.other]\n')).toBe(false);
    });
  });

  describe('mergeFeaturesCodexHooks', () => {
    it('appends [features] when missing', () => {
      const out = mergeFeaturesCodexHooks('foo = 1\n');
      expect(out).toContain('[features]');
      expect(out).toContain('codex_hooks = true');
    });

    it('does not duplicate codex_hooks', () => {
      const base = '[features]\ncodex_hooks = true\n';
      expect(mergeFeaturesCodexHooks(base)).toBe(base);
    });

    it('replaces codex_hooks = false with true so hooks are not ignored at runtime', () => {
      const out = mergeFeaturesCodexHooks('[features]\ncodex_hooks = false\n');
      expect(out).toContain('codex_hooks = true');
      expect(out).not.toMatch(/codex_hooks\s*=\s*false/);
    });

    it('mergeCodexHooksFeatureProjectLayerIfPresent upgrades project layer when codex_hooks was false', async () => {
      const root = mkdtempSync(join(tmpdir(), 'sonar-codex-proj-layer-'));
      const configPath = join(root, '.codex', 'config.toml');
      try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, '[features]\ncodex_hooks = false\nother = 1\n');
        const changed = await mergeCodexHooksFeatureProjectLayerIfPresent(root);
        expect(changed).toBe(true);
        const next = readFileSync(configPath, 'utf-8');
        expect(next).toContain('codex_hooks = true');
        expect(next).not.toMatch(/codex_hooks\s*=\s*false/);
        expect(next).toContain('other = 1');
        const changedAgain = await mergeCodexHooksFeatureProjectLayerIfPresent(root);
        expect(changedAgain).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  /** https://developers.openai.com/codex/hooks — matcher table for PreToolUse / PostToolUse */
  describe('installCodexHooks — OpenAI Codex hooks.json shape', () => {
    it('uses Bash matchers for PreToolUse and PostToolUse when SQAA is installed', async () => {
      if (!isCodexHooksSupportedOnPlatform()) {
        return;
      }
      const root = mkdtempSync(join(tmpdir(), 'sonar-codex-hooks-doc-'));
      try {
        await installCodexHooks(root, undefined, true, 'my-project-key');
        const raw = readFileSync(codexHooksJsonPath(root), 'utf-8');
        const json = JSON.parse(raw) as {
          hooks?: Record<
            string,
            Array<{
              matcher: string;
              hooks: Array<{ type: string; command: string; timeout?: number }>;
            }>
          >;
        };
        expect(json.hooks?.PreToolUse?.[0]?.matcher).toBe('Bash');
        const post = json.hooks?.PostToolUse ?? [];
        const sqaa = post.find((g) => g.hooks.some((h) => h.command.includes('sonar-sqaa')));
        expect(sqaa?.matcher).toBe('Bash');
        const cmd = json.hooks?.PreToolUse?.[0]?.hooks[0]?.command;
        expect(isAbsolute(cmd ?? '')).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  /** https://developers.openai.com/codex/mcp — STDIO server: command, args, env table */
  describe('writeCodexTomlIntegration — OpenAI Codex MCP config shape', () => {
    it('writes [mcp_servers.sonarqube] with command, args, and .env subsection', async () => {
      const root = mkdtempSync(join(tmpdir(), 'sonar-codex-mcp-doc-'));
      const configPath = join(root, '.codex', 'config.toml');
      const auth: ResolvedAuth = {
        token: 't',
        serverUrl: 'https://sonarcloud.io',
        orgKey: 'org',
        connectionType: 'cloud',
      };
      try {
        await writeCodexTomlIntegration({
          configFilePath: configPath,
          auth,
          isGlobal: false,
          projectRoot: root,
          projectKey: 'pk',
          includeMcp: true,
          includeHooksFeature: true,
        });
        const toml = readFileSync(configPath, 'utf-8');
        expect(hasSonarqubeMcpBlockInToml(toml)).toBe(true);
        expect(toml).toMatch(/^command\s*=\s*"/m);
        expect(toml).toMatch(/^args\s*=\s*\[/m);
        expect(toml).toContain('[mcp_servers.sonarqube.env]');
        expect(toml).toContain('SONARQUBE_PROJECT_KEY = "pk"');
        expect(toml).toContain('codex_hooks = true');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('Secret Scanning Hook Templates (Codex)', () => {
    it('PreTool Unix hook: Bash tool, sonar analyze secrets on command text', () => {
      const template = getCodexSecretPreToolTemplateUnix();

      expect(template.startsWith('#!/bin/bash')).toBe(true);
      expect(template.includes('"Bash"')).toBe(true);
      expect(template.includes('command -v sonar')).toBe(true);
      expect(template.includes('"$SONAR" analyze secrets')).toBe(true);
      expect(template.includes('permissionDecision')).toBe(true);
      expect(template.includes('systemMessage')).toBe(true);
    });

    it('UserPromptSubmit Unix hook: exits 2 with stderr message when blocking (Codex App shows exit-2 reason)', () => {
      const template = getCodexSecretPromptTemplateUnix();

      expect(template.startsWith('#!/bin/bash')).toBe(true);
      expect(template.includes('command -v sonar')).toBe(true);
      expect(template.includes('"$SONAR" analyze secrets')).toBe(true);
      // Per https://developers.openai.com/codex/hooks: exit 2 + stderr is the mechanism that
      // surfaces a user-visible blocking reason in the Codex App UI.
      expect(template.includes('exit 2')).toBe(true);
      expect(template.includes('>&2')).toBe(true);
      expect(template.includes('.payload.prompt')).toBe(true);
      expect(template.includes('.payload.message')).toBe(true);
    });

    it('PostToolUse Unix hook: handles a sample Codex Bash payload and emits SQAA context', () => {
      if (!isCodexHooksSupportedOnPlatform()) {
        return;
      }

      const root = mkdtempSync(join(tmpdir(), 'sonar-codex-sqaa-template-'));
      const homeDir = join(root, 'home');
      const repoDir = join(root, 'repo');
      const sonarBinDir = join(homeDir, '.local', 'share', 'sonarqube-cli', 'bin');
      const scriptPath = join(root, 'posttool-sqaa.sh');
      const payloadPath = join(root, 'payload.json');
      const sourceFile = join(repoDir, 'src', 'example.ts');

      try {
        mkdirSync(join(repoDir, 'src'), { recursive: true });
        mkdirSync(sonarBinDir, { recursive: true });
        writeFileSync(sourceFile, 'export const example = 1;\n');
        writeFileSync(
          join(sonarBinDir, 'sonar'),
          '#!/bin/bash\nif [[ "$1 $2" == "analyze sqaa" ]]; then\n  printf \'SQAA OK\'\nfi\n',
          { mode: 0o755 },
        );
        writeFileSync(scriptPath, getCodexSqaaPostToolTemplateUnix('my-project'), { mode: 0o755 });

        const gitInit = Bun.spawnSync({
          cmd: ['git', 'init'],
          cwd: repoDir,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(gitInit.exitCode).toBe(0);

        const payload = JSON.stringify({
          tool_name: 'Bash',
          cwd: repoDir,
          tool_input: {
            command: "printf 'export const example = 2;\\n' > src/example.ts",
          },
        });
        writeFileSync(payloadPath, payload);

        const result = Bun.spawnSync({
          cmd: ['bash', '-lc', '"$0" < "$1"', scriptPath, payloadPath],
          cwd: repoDir,
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...process.env,
            HOME: homeDir,
            PATH: process.env.PATH ?? '',
          },
        });
        const stdout = decodeSpawnOutput(result.stdout);

        expect(result.exitCode).toBe(0);
        expect(stdout).toContain('"hookEventName":"PostToolUse"');
        expect(stdout).toContain('src/example.ts');
        expect(stdout).toContain('SQAA OK');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('installCodexHooks failure handling', () => {
    it('returns failure when hooks.json is invalid and does not report secrets hooks installed', async () => {
      if (!isCodexHooksSupportedOnPlatform()) {
        return;
      }

      const root = mkdtempSync(join(tmpdir(), 'sonar-codex-invalid-hooks-'));
      try {
        mkdirSync(join(root, '.codex'), { recursive: true });
        writeFileSync(join(root, '.codex', 'hooks.json'), '{ invalid json');

        const result = await installCodexHooks(root, undefined, false);

        expect(result.secretsHooksInstalled).toBe(false);
        expect(result.sqaaHookInstalled).toBe(false);
        expect(readFileSync(join(root, '.codex', 'hooks.json'), 'utf-8')).toBe('{ invalid json');
        expect(
          existsSync(
            join(root, '.codex', 'hooks', 'sonar-secrets', 'build-scripts', 'pretool-secrets.sh'),
          ),
        ).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('updateStateAfterCodexConfiguration', () => {
    let loadStateSpy: ReturnType<typeof spyOn>;
    let saveStateSpy: ReturnType<typeof spyOn>;
    let state = getDefaultState('test');

    const baseConfig: ConfigurationData = {
      serverURL: 'https://sonarcloud.io',
      projectKey: 'my-project',
      organization: 'my-org',
      token: 'test-token',
    };

    beforeEach(() => {
      state = getDefaultState('test');
      loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(state);
      saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
    });

    afterEach(() => {
      loadStateSpy.mockRestore();
      saveStateSpy.mockRestore();
    });

    it('does not record sonar-sqaa when SQAA hook was not installed', () => {
      updateStateAfterCodexConfiguration(baseConfig, '/repo', false, true, false);

      expect(state.agentExtensions.some((e) => e.name === 'sonar-sqaa')).toBe(false);
    });

    it('does not record sonar-sqaa when no project key is available', () => {
      updateStateAfterCodexConfiguration(
        { ...baseConfig, projectKey: undefined },
        '/repo',
        false,
        true,
        false,
      );

      expect(state.agentExtensions.some((e) => e.name === 'sonar-sqaa')).toBe(false);
    });
  });
});
