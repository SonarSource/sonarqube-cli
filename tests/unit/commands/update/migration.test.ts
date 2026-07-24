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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  cleanObsoleteFromState,
  migrateHookScripts,
  OBSOLETE_A3S_MARKER,
  removeObsoleteHookArtifacts,
} from '@/core/host/migration.ts';
import type { AgentExtension, CliState, HookExtension } from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import { setMockUi } from '@/core/ui';

const OLD_VERSION = '0.4.0';

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

describe('migrateHookScripts', () => {
  let testDir: string;

  beforeEach(() => {
    setMockUi(true);
    testDir = join(tmpdir(), `sonar-cli-migration-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    setMockUi(false);
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeOldScript(filename: string, content: string): string {
    const dir = join(testDir, '.claude', 'hooks', 'sonar-secrets', 'build-scripts');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, filename);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  it('rewrites sonar analyze to sonar analyze secrets in Unix scripts', () => {
    const scriptPath = writeOldScript(
      'pretool-secrets.sh',
      '#!/bin/bash\nsonar analyze --file "$filePath" > /dev/null 2>&1\n',
    );

    migrateHookScripts(testDir);

    const content = readFileSync(scriptPath, 'utf-8');
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

    migrateHookScripts(testDir);

    for (const [, path] of Object.entries(paths)) {
      const content = readFileSync(path, 'utf-8');
      expect(content).toContain('sonar analyze secrets');
      expect(content).not.toContain('sonar analyze --file');
    }
  });

  it('uses globalDir over projectRoot when provided', () => {
    const globalDir = join(testDir, 'global');
    const dir = join(globalDir, '.claude', 'hooks', 'sonar-secrets', 'build-scripts');
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, 'pretool-secrets.sh');
    writeFileSync(scriptPath, '#!/bin/bash\nsonar analyze --file "$f"\n', 'utf-8');

    migrateHookScripts(testDir, globalDir);

    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('sonar analyze secrets');
    expect(content).not.toContain('sonar analyze --file');
  });

  it('leaves already-migrated scripts unchanged', () => {
    const migrated = '#!/bin/bash\nsonar analyze secrets "$file_path"\n';
    const scriptPath = writeOldScript('pretool-secrets.sh', migrated);

    migrateHookScripts(testDir);

    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toBe(migrated);
  });

  it('completes without error when hook scripts do not exist on disk', () => {
    // testDir has no hook scripts
    expect(() => migrateHookScripts(testDir)).not.toThrow();
  });

  it('logs debug and continues when a hook script cannot be read (read error)', () => {
    // Create a directory where the script path is expected to be a file
    // (causes readFileSync to throw EISDIR), exercising the catch branch
    const secretsDir = join(testDir, '.claude', 'hooks', 'sonar-secrets', 'build-scripts');
    mkdirSync(secretsDir, { recursive: true });
    mkdirSync(join(secretsDir, 'pretool-secrets.sh'), { recursive: true });

    expect(() => migrateHookScripts(testDir)).not.toThrow();
  });
});

describe('removeObsoleteHookArtifacts', () => {
  let testDir: string;

  beforeEach(() => {
    setMockUi(true);
    testDir = join(tmpdir(), `sonar-cli-migration-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    setMockUi(false);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('deletes the obsolete sonar-a3s hook directory', async () => {
    const a3sDir = join(testDir, '.claude', 'hooks', OBSOLETE_A3S_MARKER, 'build-scripts');
    mkdirSync(a3sDir, { recursive: true });

    await removeObsoleteHookArtifacts(testDir, OBSOLETE_A3S_MARKER);

    expect(existsSync(join(testDir, '.claude', 'hooks', OBSOLETE_A3S_MARKER))).toBe(false);
  });

  it('removes settings.json entries whose command references the marker and keeps others', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    writeFileSync(
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

    await removeObsoleteHookArtifacts(testDir, OBSOLETE_A3S_MARKER);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks: { PostToolUse: { hooks: { command: string }[] }[] };
    };
    const commands = settings.hooks.PostToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toEqual(['sonar hook sonar-secrets run']);
  });

  it('does not throw when the settings file does not exist', async () => {
    const result = await removeObsoleteHookArtifacts(testDir, OBSOLETE_A3S_MARKER);
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

    cleanObsoleteFromState(state, OBSOLETE_A3S_MARKER);

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

    cleanObsoleteFromState(state, OBSOLETE_A3S_MARKER);

    expect(state.agentExtensions.some((e) => e.name === OBSOLETE_A3S_MARKER)).toBe(false);
  });

  it('does not remove unrelated entries from legacy hooks.installed', () => {
    const state = getDefaultState('test');
    state.agents['claude-code'].hooks.installed.push(
      { name: OBSOLETE_A3S_MARKER, type: 'PostToolUse', installedAt: new Date().toISOString() },
      { name: 'sonar-secrets', type: 'PreToolUse', installedAt: new Date().toISOString() },
    );

    cleanObsoleteFromState(state, OBSOLETE_A3S_MARKER);

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

    cleanObsoleteFromState(state, OBSOLETE_A3S_MARKER);

    const survivors = state.agentExtensions.filter(
      (e): e is HookExtension => e.kind === 'hook' && e.name === 'sonar-secrets',
    );
    expect(survivors).toHaveLength(1);
  });
});
