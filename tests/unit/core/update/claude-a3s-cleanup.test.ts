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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { AgentExtension, CliState, HookExtension } from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as cleanup from '@/core/update/claude-a3s-cleanup.ts';

// Mirrors the private OBSOLETE_A3S_MARKER constant in claude-a3s-cleanup.ts.
const OBSOLETE_A3S_MARKER = 'sonar-a3s';
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

    await cleanup.removeObsoleteHookArtifacts(testDir);

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

    await cleanup.removeObsoleteHookArtifacts(testDir);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: { PostToolUse: { hooks: { command: string }[] }[] };
    };
    const commands = settings.hooks.PostToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toEqual(['sonar hook sonar-secrets run']);
  });

  it('does not throw when the settings file does not exist', async () => {
    const result = await cleanup.removeObsoleteHookArtifacts(testDir);
    expect(result).toBeUndefined();
  });
});

describe('cleanObsoleteFromState', () => {
  it('removes obsolete extensions when legacy agent state is absent', () => {
    const state = getDefaultState('test');
    delete (state as Partial<CliState>).agents;
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

    cleanup.cleanObsoleteFromState(state);

    expect(state.agentExtensions).toEqual([]);
  });

  it('removes sonar-a3s from legacy hooks.installed', () => {
    const state = getDefaultState('test');
    state.agents['claude-code'].hooks.installed.push({
      name: OBSOLETE_A3S_MARKER,
      type: 'PostToolUse',
      installedAt: new Date().toISOString(),
    });

    cleanup.cleanObsoleteFromState(state);

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

    cleanup.cleanObsoleteFromState(state);

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

    cleanup.cleanObsoleteFromState(state);

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

    cleanup.cleanObsoleteFromState(state);

    const survivors = state.agentExtensions.filter(
      (e): e is HookExtension => e.kind === 'hook' && e.name === 'sonar-secrets',
    );
    expect(survivors).toHaveLength(1);
  });
});
