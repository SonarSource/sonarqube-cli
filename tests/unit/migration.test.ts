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

// Unit tests for auto-migration logic (src/bootstrap/migration.ts)

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockUi } from '../../src/ui';
import * as stateManager from '../../src/lib/state-manager.js';
import * as hooks from '../../src/bootstrap/hooks.js';
import { getDefaultState } from '../../src/lib/state.js';
import type { HookExtension } from '../../src/lib/state.js';
import { runMigrations } from '../../src/bootstrap/migration.js';
import { version as CURRENT_VERSION } from '../../package.json';

const OLD_VERSION = '0.4.0';
const CLI_105_VERSION = '0.5.1';

describe('runMigrations — skip conditions', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let addInstalledHookSpy: ReturnType<typeof spyOn>;
  let installHooksSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
    addInstalledHookSpy = spyOn(stateManager, 'addInstalledHook').mockImplementation(
      () => undefined,
    );
    installHooksSpy = spyOn(hooks, 'installSecretScanningHooks').mockResolvedValue(undefined);
  });

  afterEach(() => {
    setMockUi(false);
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    addInstalledHookSpy.mockRestore();
    installHooksSpy.mockRestore();
  });

  it('skips when agent is not configured', async () => {
    // Default state has configured: false
    await runMigrations('/some/project');

    expect(installHooksSpy).not.toHaveBeenCalled();
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  it('skips when configuredByCliVersion is missing', async () => {
    const state = getDefaultState('test');
    state.agents['claude-code'].configured = true;
    state.agents['claude-code'].configuredByCliVersion = undefined;
    loadStateSpy.mockReturnValue(state);

    await runMigrations('/some/project');

    expect(installHooksSpy).not.toHaveBeenCalled();
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  it('skips when installed version matches current version', async () => {
    const state = getDefaultState('test');
    state.agents['claude-code'].configured = true;
    state.agents['claude-code'].configuredByCliVersion = CURRENT_VERSION;
    loadStateSpy.mockReturnValue(state);

    await runMigrations('/some/project');

    expect(installHooksSpy).not.toHaveBeenCalled();
    expect(saveStateSpy).not.toHaveBeenCalled();
  });
});

describe('runMigrations — migration execution', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let addInstalledHookSpy: ReturnType<typeof spyOn>;
  let installHooksSpy: ReturnType<typeof spyOn>;

  function makeConfiguredState(version: string) {
    const state = getDefaultState('test');
    state.agents['claude-code'].configured = true;
    state.agents['claude-code'].configuredByCliVersion = version;
    return state;
  }

  beforeEach(() => {
    setMockUi(true);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
    addInstalledHookSpy = spyOn(stateManager, 'addInstalledHook').mockImplementation(
      () => undefined,
    );
    installHooksSpy = spyOn(hooks, 'installSecretScanningHooks').mockResolvedValue(undefined);
  });

  afterEach(() => {
    setMockUi(false);
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    addInstalledHookSpy.mockRestore();
    installHooksSpy.mockRestore();
  });

  it('calls installSecretScanningHooks when version differs from current', async () => {
    loadStateSpy.mockReturnValue(makeConfiguredState(OLD_VERSION));

    await runMigrations('/some/project');

    expect(installHooksSpy).toHaveBeenCalledWith('/some/project', undefined);
  });

  it('passes globalDir to installSecretScanningHooks when provided', async () => {
    loadStateSpy.mockReturnValue(makeConfiguredState(OLD_VERSION));

    await runMigrations('/some/project', '/global/dir');

    expect(installHooksSpy).toHaveBeenCalledWith('/some/project', '/global/dir');
  });

  it('registers sonar-a3s PostToolUse hook in state', async () => {
    loadStateSpy.mockReturnValue(makeConfiguredState(OLD_VERSION));

    await runMigrations('/some/project');

    expect(addInstalledHookSpy).toHaveBeenCalledWith(
      expect.anything(),
      'claude-code',
      'sonar-a3s',
      'PostToolUse',
    );
  });

  it('updates configuredByCliVersion to current version after migration', async () => {
    const state = makeConfiguredState(OLD_VERSION);
    loadStateSpy.mockReturnValue(state);

    await runMigrations('/some/project');

    expect(state.agents['claude-code'].configuredByCliVersion).toBe(CURRENT_VERSION);
  });

  it('sets migratedAt timestamp after migration', async () => {
    const state = makeConfiguredState(OLD_VERSION);
    loadStateSpy.mockReturnValue(state);

    await runMigrations('/some/project');

    expect(state.agents['claude-code'].migratedAt).toBeDefined();
    // Should be a valid ISO timestamp
    expect(() => new Date(state.agents['claude-code'].migratedAt!)).not.toThrow();
  });

  it('saves state after migration', async () => {
    loadStateSpy.mockReturnValue(makeConfiguredState(OLD_VERSION));

    await runMigrations('/some/project');

    expect(saveStateSpy).toHaveBeenCalled();
  });

  it('is non-blocking: resolves without throwing when installSecretScanningHooks fails', async () => {
    loadStateSpy.mockReturnValue(makeConfiguredState(OLD_VERSION));
    installHooksSpy.mockRejectedValue(new Error('Hook install failed'));

    await runMigrations('/some/project');
  });

  it('populates agentExtensions registry with sonar-a3s for cloud connections', async () => {
    const state = makeConfiguredState(OLD_VERSION);
    // Directly populate hooks.installed to simulate pre-registry state
    // (addInstalledHook is mocked in beforeEach so we must mutate directly)
    state.agents['claude-code'].hooks.installed.push(
      { name: 'sonar-secrets', type: 'PreToolUse', installedAt: new Date().toISOString() },
      { name: 'sonar-secrets', type: 'UserPromptSubmit', installedAt: new Date().toISOString() },
    );
    stateManager.addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
      orgKey: 'my-org',
      keystoreKey: 'sonarcloud.io:my-org',
    });
    loadStateSpy.mockReturnValue(state);

    await runMigrations('/some/project');

    const a3sExts = state.agentExtensions.filter(
      (e): e is HookExtension =>
        e.kind === 'hook' && e.name === 'sonar-a3s' && e.hookType === 'PostToolUse',
    );
    expect(a3sExts.length).toBeGreaterThan(0);
    expect(a3sExts[0].projectRoot).toBe('/some/project');
  });

  it('migrates old hooks.installed entries to agentExtensions', async () => {
    const state = makeConfiguredState(OLD_VERSION);
    // Directly populate hooks.installed (addInstalledHook is mocked in beforeEach)
    state.agents['claude-code'].hooks.installed.push({
      name: 'sonar-secrets',
      type: 'PreToolUse',
      installedAt: new Date().toISOString(),
    });
    stateManager.addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
      orgKey: 'my-org',
      keystoreKey: 'sonarcloud.io:my-org',
    });
    loadStateSpy.mockReturnValue(state);

    await runMigrations('/some/project');

    const secretsExts = state.agentExtensions.filter(
      (e): e is HookExtension =>
        e.kind === 'hook' && e.name === 'sonar-secrets' && e.hookType === 'PreToolUse',
    );
    expect(secretsExts.length).toBe(1);
    expect(secretsExts[0].projectRoot).toBe('/some/project');
  });
});

describe('runMigrations — CLI-105 patch', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let addInstalledHookSpy: ReturnType<typeof spyOn>;
  let installHooksSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
    addInstalledHookSpy = spyOn(stateManager, 'addInstalledHook').mockImplementation(
      () => undefined,
    );
    installHooksSpy = spyOn(hooks, 'installSecretScanningHooks').mockResolvedValue(undefined);
  });

  afterEach(() => {
    setMockUi(false);
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    addInstalledHookSpy.mockRestore();
    installHooksSpy.mockRestore();
  });

  it('adds missing PreToolUse when v0.5.1 has only UserPromptSubmit hook', async () => {
    const state = getDefaultState('test');
    state.agents['claude-code'].configured = true;
    state.agents['claude-code'].configuredByCliVersion = CLI_105_VERSION;
    state.agents['claude-code'].hooks.installed = [
      {
        name: 'sonar-secrets',
        type: 'UserPromptSubmit',
        installedAt: new Date().toISOString(),
      },
    ];
    loadStateSpy.mockReturnValue(state);

    await runMigrations('/some/project');

    expect(addInstalledHookSpy).toHaveBeenCalledWith(
      expect.anything(),
      'claude-code',
      'sonar-secrets',
      'PreToolUse',
    );
  });

  it('does not patch when v0.5.1 already has both sonar-secrets hooks', async () => {
    const state = getDefaultState('test');
    state.agents['claude-code'].configured = true;
    state.agents['claude-code'].configuredByCliVersion = CLI_105_VERSION;
    state.agents['claude-code'].hooks.installed = [
      { name: 'sonar-secrets', type: 'UserPromptSubmit', installedAt: new Date().toISOString() },
      { name: 'sonar-secrets', type: 'PreToolUse', installedAt: new Date().toISOString() },
    ];
    loadStateSpy.mockReturnValue(state);

    await runMigrations('/some/project');

    const secretsPreToolCalls = addInstalledHookSpy.mock.calls.filter(
      (call: unknown[]) => call[2] === 'sonar-secrets' && call[3] === 'PreToolUse',
    );
    expect(secretsPreToolCalls).toHaveLength(0);
  });

  it('does not patch when v0.5.1 has a PreToolUse hook already (non-UserPromptSubmit only)', async () => {
    const state = getDefaultState('test');
    state.agents['claude-code'].configured = true;
    state.agents['claude-code'].configuredByCliVersion = CLI_105_VERSION;
    state.agents['claude-code'].hooks.installed = [
      { name: 'sonar-secrets', type: 'PreToolUse', installedAt: new Date().toISOString() },
    ];
    loadStateSpy.mockReturnValue(state);

    await runMigrations('/some/project');

    const secretsPreToolCalls = addInstalledHookSpy.mock.calls.filter(
      (call: unknown[]) => call[2] === 'sonar-secrets' && call[3] === 'PreToolUse',
    );
    expect(secretsPreToolCalls).toHaveLength(0);
  });
});

describe('runMigrations — hook script rewriting', () => {
  let testDir: string;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let addInstalledHookSpy: ReturnType<typeof spyOn>;
  let installHooksSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    testDir = join(tmpdir(), `sonar-cli-migration-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const state = getDefaultState('test');
    state.agents['claude-code'].configured = true;
    state.agents['claude-code'].configuredByCliVersion = OLD_VERSION;

    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(state);
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
    addInstalledHookSpy = spyOn(stateManager, 'addInstalledHook').mockImplementation(
      () => undefined,
    );
    installHooksSpy = spyOn(hooks, 'installSecretScanningHooks').mockResolvedValue(undefined);
  });

  afterEach(() => {
    setMockUi(false);
    rmSync(testDir, { recursive: true, force: true });
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    addInstalledHookSpy.mockRestore();
    installHooksSpy.mockRestore();
  });

  function writeOldScript(filename: string, content: string): string {
    const dir = join(testDir, '.claude', 'hooks', 'sonar-secrets', 'build-scripts');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, filename);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  it('rewrites sonar analyze --file to sonar analyze secrets --file in Unix scripts', async () => {
    const scriptPath = writeOldScript(
      'pretool-secrets.sh',
      '#!/bin/bash\nsonar analyze --file "$file_path" > /dev/null 2>&1\n',
    );

    await runMigrations(testDir);

    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('sonar analyze secrets --file');
    expect(content).not.toContain('sonar analyze --file');
  });

  it('rewrites all four hook script variants', async () => {
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

    await runMigrations(testDir);

    for (const [, path] of Object.entries(paths)) {
      const content = readFileSync(path, 'utf-8');
      expect(content).toContain('sonar analyze secrets --file');
      expect(content).not.toContain('sonar analyze --file');
    }
  });

  it('leaves already-migrated scripts unchanged', async () => {
    const migrated = '#!/bin/bash\nsonar analyze secrets --file "$file_path"\n';
    const scriptPath = writeOldScript('pretool-secrets.sh', migrated);

    await runMigrations(testDir);

    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toBe(migrated);
  });

  it('completes without error when hook scripts do not exist on disk', async () => {
    // testDir has no hook scripts
    await runMigrations(testDir);
  });
});
