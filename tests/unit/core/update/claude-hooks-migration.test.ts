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

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';

import { CLAUDE_INTEGRATION_ID } from '@/commands/integrate/claude/declaration.ts';
import * as hooks from '@/commands/integrate/claude/hooks.ts';
import type { AgentExtension, CliState, HookExtension } from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import * as migration from '@/core/update/claude-hooks-migration.ts';
import { migrateClaudeCodeHooks } from '@/core/update/claude-hooks-migration.ts';

const FAKE_HOME = '/fake/home';
const homedirFn = () => FAKE_HOME;
const OLD_VERSION = '0.4.0';
// Mirrors the private OBSOLETE_A3S_MARKER constant in claude-hooks-migration.ts.
const OBSOLETE_A3S_MARKER = 'sonar-a3s';

function makeState(): CliState {
  return getDefaultState('1.0.0');
}

function seedAgentExtension(state: CliState, extension: AgentExtension): void {
  const idx = state.agentExtensions.findIndex(
    (e) =>
      e.agentId === extension.agentId &&
      e.projectRoot === extension.projectRoot &&
      e.kind === extension.kind &&
      e.name === extension.name &&
      (e.kind !== 'hook' || extension.kind !== 'hook' || e.hookType === extension.hookType),
  );
  if (idx >= 0) {
    state.agentExtensions[idx] = { ...extension, id: state.agentExtensions[idx].id };
  } else {
    state.agentExtensions.push(extension);
  }
}

function makeStateWithExtensions(extensions: HookExtension[], configured = true): CliState {
  const state = getDefaultState('1.0.0');
  state.agents['claude-code'].configured = configured;
  state.agentExtensions = extensions;
  return state;
}

function makeExtension(projectRoot: string, global: boolean): HookExtension {
  return {
    id: 'test-id',
    agentId: 'claude-code',
    kind: 'hook',
    name: 'sonar-secrets',
    hookType: 'PreToolUse',
    projectRoot,
    global,
    updatedByCliVersion: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('migrateClaudeCodeHooks', () => {
  let existsSyncSpy: Mock<typeof fs.existsSync>;
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let migrateHookScriptsSpy: Mock<typeof migration.migrateHookScripts>;
  let removeObsoleteHookArtifactsSpy: Mock<typeof migration.removeObsoleteHookArtifacts>;
  let installHooksSpy: Mock<typeof hooks.installHooks>;

  beforeEach(() => {
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeState());
    migrateHookScriptsSpy = spyOn(migration, 'migrateHookScripts').mockImplementation(() => {});
    removeObsoleteHookArtifactsSpy = spyOn(
      migration,
      'removeObsoleteHookArtifacts',
    ).mockResolvedValue(undefined);
    installHooksSpy = spyOn(hooks, 'installHooks').mockResolvedValue(undefined);
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    loadStateSpy.mockRestore();
    migrateHookScriptsSpy.mockRestore();
    removeObsoleteHookArtifactsSpy.mockRestore();
    installHooksSpy.mockRestore();
  });

  it('does not install hooks when agent is not configured and registry is empty', async () => {
    loadStateSpy.mockReturnValue(makeState()); // configured = false, no extensions

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).not.toHaveBeenCalled();
  });

  it('does not install hooks when agent is configured but registry is empty and no global hooks dir exists', async () => {
    const state = makeStateWithExtensions([]); // configured, no extensions
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(false); // globalHooksDir does not exist

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).not.toHaveBeenCalled();
  });

  it('does not install hooks when registry contains only skill extensions', async () => {
    const state = makeStateWithExtensions([]);
    state.agentExtensions = [
      {
        id: 'skill-id',
        agentId: 'claude-code',
        kind: 'skill',
        name: 'sonar-context-augmentation',
        projectRoot: '/some/project',
        global: false,
        updatedByCliVersion: '1.0.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(false); // global hooks dir does not exist

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).not.toHaveBeenCalled();
    expect(migrateHookScriptsSpy).not.toHaveBeenCalled();
  });

  it('skips legacy migration when Claude is already tracked declaratively', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    state.integrations.installed.push({
      id: 'claude-integration-id',
      integrationId: 'claude-code',
      installedByCliVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedByCliVersion: '1.0.0',
      updatedAt: '2026-01-01T00:00:00.000Z',
      features: [
        {
          featureId: 'mcp-server',
          scope: 'project',
          targetRoot: '/proj/root',
          installedByCliVersion: '1.0.0',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedByCliVersion: '1.0.0',
          updatedAt: '2026-01-01T00:00:00.000Z',
          dependencies: [],
          resources: [],
          operations: [],
        },
      ],
    });
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).not.toHaveBeenCalled();
    expect(migrateHookScriptsSpy).not.toHaveBeenCalled();
  });

  it('does not skip legacy migration for an empty declarative Claude container', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    state.integrations.installed.push({
      id: 'claude-integration-id',
      integrationId: 'claude-code',
      installedByCliVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedByCliVersion: '1.0.0',
      updatedAt: '2026-01-01T00:00:00.000Z',
      features: [],
    });
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(1);
    expect(migrateHookScriptsSpy).toHaveBeenCalledTimes(1);
  });

  it('installs hooks for each extension in the registry', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(1);
  });

  it('passes projectRoot and undefined globalDir for non-global extensions', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledWith('/proj/root', undefined);
  });

  it('passes projectRoot and homedirFn() as globalDir for global extensions', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', true)]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledWith('/proj/root', FAKE_HOME);
  });

  it('migrates hook scripts for each location before installing hooks', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(migrateHookScriptsSpy).toHaveBeenCalledTimes(1);
    expect(migrateHookScriptsSpy).toHaveBeenCalledWith('/proj/root', undefined);
  });

  it('deduplicates locations - installs hooks once for repeated (projectRoot, globalDir)', async () => {
    const state = makeStateWithExtensions([
      makeExtension('/proj/root', false),
      makeExtension('/proj/root', false),
    ]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(1);
  });

  it('installs hooks for multiple distinct locations', async () => {
    const state = makeStateWithExtensions([
      makeExtension('/proj/alpha', false),
      makeExtension('/proj/beta', false),
    ]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to global migration when registry is empty, agent is configured, and global hooks dir exists', async () => {
    const state = makeStateWithExtensions([]); // configured, no extensions
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(true); // globalHooksDir exists

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(1);
  });

  it('uses homedirFn() as both projectRoot and globalDir in the pre-registry fallback', async () => {
    const state = makeStateWithExtensions([]);
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(true);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledWith(FAKE_HOME, FAKE_HOME);
  });

  it('does not fall back when agent is not configured', async () => {
    const state = makeStateWithExtensions([], false); // configured = false
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(true); // hooks dir exists, but shouldn't matter

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).not.toHaveBeenCalled();
  });

  it('continues installing remaining locations when one throws', async () => {
    const state = makeStateWithExtensions([
      makeExtension('/proj/alpha', false),
      makeExtension('/proj/beta', false),
    ]);
    loadStateSpy.mockReturnValue(state);
    migrateHookScriptsSpy.mockImplementationOnce(() => {
      throw new Error('migrate failed');
    });

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    // First location failed, but second location still ran
    expect(installHooksSpy).toHaveBeenCalledTimes(1);
    expect(installHooksSpy).toHaveBeenCalledWith('/proj/beta', undefined);
  });

  it('does not throw when a location migration fails', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    loadStateSpy.mockReturnValue(state);
    installHooksSpy.mockRejectedValue(new Error('hook install failed'));

    const actual = await migrateClaudeCodeHooks(
      hooks.installHooks,
      CLAUDE_INTEGRATION_ID,
      homedirFn,
    );

    expect(actual).toBeUndefined();
  });

  it('calls removeObsoleteHookArtifacts once per location', async () => {
    const state = makeStateWithExtensions([
      makeExtension('/proj/alpha', false),
      makeExtension('/proj/beta', false),
    ]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(removeObsoleteHookArtifactsSpy).toHaveBeenCalledTimes(2);
    expect(removeObsoleteHookArtifactsSpy).toHaveBeenCalledWith('/proj/alpha');
    expect(removeObsoleteHookArtifactsSpy).toHaveBeenCalledWith('/proj/beta');
  });
});

describe('migrateHookScripts', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `sonar-cli-migration-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function writeOldScript(filename: string, content: string): string {
    const dir = join(testDir, '.claude', 'hooks', 'sonar-secrets', 'build-scripts');
    fs.mkdirSync(dir, { recursive: true });
    const path = join(dir, filename);
    fs.writeFileSync(path, content, 'utf-8');
    return path;
  }

  it('rewrites sonar analyze to sonar analyze secrets in Unix scripts', () => {
    const scriptPath = writeOldScript(
      'pretool-secrets.sh',
      '#!/bin/bash\nsonar analyze --file "$filePath" > /dev/null 2>&1\n',
    );

    migration.migrateHookScripts(testDir);

    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('sonar analyze secrets');
    expect(content).not.toContain('sonar analyze --file');
  });

  it('rewrites all four hook script variants', () => {
    const scripts = {
      'pretool-secrets.sh': '#!/bin/bash\nsonar analyze --file "$f"\n',
      'prompt-secrets.sh': '#!/bin/bash\nsonar analyze --file "$f"\n',
      'pretool-secrets.ps1': '& sonar analyze --file $f\n',
      'prompt-secrets.ps1': '& sonar analyze --file $f\n',
    };

    const paths: Record<string, string> = {};
    for (const [name, content] of Object.entries(scripts)) {
      paths[name] = writeOldScript(name, content);
    }

    migration.migrateHookScripts(testDir);

    for (const [, path] of Object.entries(paths)) {
      const content = fs.readFileSync(path, 'utf-8');
      expect(content).toContain('sonar analyze secrets');
      expect(content).not.toContain('sonar analyze --file');
    }
  });

  it('uses globalDir over projectRoot when provided', () => {
    const globalDir = join(testDir, 'global');
    const dir = join(globalDir, '.claude', 'hooks', 'sonar-secrets', 'build-scripts');
    fs.mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, 'pretool-secrets.sh');
    fs.writeFileSync(scriptPath, '#!/bin/bash\nsonar analyze --file "$f"\n', 'utf-8');

    migration.migrateHookScripts(testDir, globalDir);

    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('sonar analyze secrets');
    expect(content).not.toContain('sonar analyze --file');
  });

  it('leaves already-migrated scripts unchanged', () => {
    const migrated = '#!/bin/bash\nsonar analyze secrets "$file_path"\n';
    const scriptPath = writeOldScript('pretool-secrets.sh', migrated);

    migration.migrateHookScripts(testDir);

    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toBe(migrated);
  });

  it('completes without error when hook scripts do not exist on disk', () => {
    // testDir has no hook scripts
    expect(() => migration.migrateHookScripts(testDir)).not.toThrow();
  });

  it('logs debug and continues when a hook script cannot be read (read error)', () => {
    // Create a directory where the script path is expected to be a file
    // (causes readFileSync to throw EISDIR), exercising the catch branch
    const secretsDir = join(testDir, '.claude', 'hooks', 'sonar-secrets', 'build-scripts');
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.mkdirSync(join(secretsDir, 'pretool-secrets.sh'), { recursive: true });

    expect(() => migration.migrateHookScripts(testDir)).not.toThrow();
  });
});

describe('removeObsoleteHookArtifacts', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `sonar-cli-migration-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('deletes the obsolete sonar-a3s hook directory', async () => {
    const a3sDir = join(testDir, '.claude', 'hooks', OBSOLETE_A3S_MARKER, 'build-scripts');
    fs.mkdirSync(a3sDir, { recursive: true });

    await migration.removeObsoleteHookArtifacts(testDir);

    expect(fs.existsSync(join(testDir, '.claude', 'hooks', OBSOLETE_A3S_MARKER))).toBe(false);
  });

  it('removes settings.json entries whose command references the marker and keeps others', async () => {
    const claudeDir = join(testDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              { hooks: [{ command: `sonar hook ${OBSOLETE_A3S_MARKER} run` }] },
              { hooks: [{ command: 'sonar hook sonar-secrets run' }] },
            ],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    await migration.removeObsoleteHookArtifacts(testDir);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: { PostToolUse: { hooks: { command: string }[] }[] };
    };
    const commands = settings.hooks.PostToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toEqual(['sonar hook sonar-secrets run']);
  });

  it('does not throw when the settings file does not exist', async () => {
    const result = await migration.removeObsoleteHookArtifacts(testDir);
    expect(result).toBeUndefined();
  });
});

describe('cleanObsoleteFromState', () => {
  it('removes sonar-a3s from legacy hooks.installed', () => {
    const state = getDefaultState('test');
    state.agents['claude-code'].hooks.installed.push({
      name: OBSOLETE_A3S_MARKER,
      type: 'PostToolUse',
      installedAt: new Date().toISOString(),
    });

    migration.cleanObsoleteFromState(state);

    expect(
      state.agents['claude-code'].hooks.installed.some((h) => h.name === OBSOLETE_A3S_MARKER),
    ).toBe(false);
  });

  it('removes sonar-a3s from agentExtensions', () => {
    const state = getDefaultState('test');
    seedAgentExtension(state, {
      id: 'a3s-ext',
      agentId: 'claude-code',
      projectRoot: '/some/project',
      global: false,
      kind: 'hook',
      name: OBSOLETE_A3S_MARKER,
      hookType: 'PostToolUse',
      updatedByCliVersion: OLD_VERSION,
      updatedAt: new Date().toISOString(),
    });

    migration.cleanObsoleteFromState(state);

    expect(state.agentExtensions.some((e) => e.name === OBSOLETE_A3S_MARKER)).toBe(false);
  });

  it('does not remove unrelated entries from legacy hooks.installed', () => {
    const state = getDefaultState('test');
    state.agents['claude-code'].hooks.installed.push(
      {
        name: OBSOLETE_A3S_MARKER,
        type: 'PostToolUse',
        installedAt: new Date().toISOString(),
      },
      { name: 'sonar-secrets', type: 'PreToolUse', installedAt: new Date().toISOString() },
    );

    migration.cleanObsoleteFromState(state);

    expect(
      state.agents['claude-code'].hooks.installed.some((h) => h.name === 'sonar-secrets'),
    ).toBe(true);
  });

  it('does not remove unrelated entries from agentExtensions', () => {
    const state = getDefaultState('test');
    seedAgentExtension(state, {
      id: 'a3s-ext',
      agentId: 'claude-code',
      projectRoot: '/some/project',
      global: false,
      kind: 'hook',
      name: OBSOLETE_A3S_MARKER,
      hookType: 'PostToolUse',
      updatedByCliVersion: OLD_VERSION,
      updatedAt: new Date().toISOString(),
    });
    seedAgentExtension(state, {
      id: 'secrets-ext',
      agentId: 'claude-code',
      projectRoot: '/some/project',
      global: false,
      kind: 'hook',
      name: 'sonar-secrets',
      hookType: 'PreToolUse',
      updatedByCliVersion: OLD_VERSION,
      updatedAt: new Date().toISOString(),
    });

    migration.cleanObsoleteFromState(state);

    const survivors = state.agentExtensions.filter(
      (e): e is HookExtension => e.kind === 'hook' && e.name === 'sonar-secrets',
    );
    expect(survivors).toHaveLength(1);
  });
});
