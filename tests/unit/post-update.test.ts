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

import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const testCliDir = join(tmpdir(), `sonar-post-update-test-${Date.now()}`);
const testStateFile = join(testCliDir, 'state.json');

void mock.module('../../src/lib/config-constants.js', () => ({
  APP_NAME: 'sonarqube-cli',
  CLI_DIR: testCliDir,
  STATE_FILE: testStateFile,
  LOG_DIR: join(testCliDir, 'logs'),
  LOG_FILE: join(testCliDir, 'logs/sonarqube-cli.log'),
  BIN_DIR: join(testCliDir, 'bin'),
  SONARSOURCE_BINARIES_URL: 'https://binaries.sonarsource.com',
  SONAR_SECRETS_DIST_PREFIX: 'CommercialDistribution/sonar-secrets',
  UPDATE_SCRIPT_BASE_URL:
    'https://raw.githubusercontent.com/SonarSource/sonarqube-cli/refs/heads/master/user-scripts',
  SONARCLOUD_HOSTNAME: 'sonarcloud.io',
  SONARCLOUD_URL: 'https://sonarcloud.io',
  SONARCLOUD_API_URL: 'https://api.sonarcloud.io',
  AUTH_PORT_START: 64120,
  AUTH_PORT_COUNT: 11,
}));

void mock.module('../../package.json', () => ({ version: '2.0.0' }));

import { getDefaultState } from '../../src/lib/state.js';
import type { HookExtension } from '../../src/lib/state.js';

const { runPostUpdateActions, migrateClaudeCodeHooks } =
  await import('../../src/lib/post-update.js');

function cleanup(): void {
  if (existsSync(testCliDir)) {
    rmSync(testCliDir, { recursive: true, force: true });
  }
}

describe('runPostUpdateActions', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('does nothing when state file does not exist (fresh install)', async () => {
    await runPostUpdateActions();
    expect(existsSync(testStateFile)).toBe(false);
  });

  it('does nothing when state version equals current version', async () => {
    mkdirSync(testCliDir, { recursive: true });
    const state = getDefaultState('2.0.0');
    const original = JSON.stringify(state);
    writeFileSync(testStateFile, original, 'utf-8');

    await runPostUpdateActions();

    const after = JSON.parse(readFileSync(testStateFile, 'utf-8')) as {
      config: { cliVersion: string };
    };
    expect(after.config.cliVersion).toBe('2.0.0');
  });

  it('does nothing when state version is ahead of current version', async () => {
    mkdirSync(testCliDir, { recursive: true });
    const state = getDefaultState('3.0.0');
    writeFileSync(testStateFile, JSON.stringify(state), 'utf-8');

    await runPostUpdateActions();

    const after = JSON.parse(readFileSync(testStateFile, 'utf-8')) as {
      config: { cliVersion: string };
    };
    expect(after.config.cliVersion).toBe('3.0.0');
  });

  it('bumps state.config.cliVersion when current version is newer', async () => {
    mkdirSync(testCliDir, { recursive: true });
    const state = getDefaultState('1.0.0');
    writeFileSync(testStateFile, JSON.stringify(state), 'utf-8');

    await runPostUpdateActions();

    const after = JSON.parse(readFileSync(testStateFile, 'utf-8')) as {
      config: { cliVersion: string };
    };
    expect(after.config.cliVersion).toBe('2.0.0');
  });

  it('preserves existing state fields when bumping version', async () => {
    mkdirSync(testCliDir, { recursive: true });
    const state = getDefaultState('1.0.0');
    state.auth.isAuthenticated = true;
    writeFileSync(testStateFile, JSON.stringify(state), 'utf-8');

    await runPostUpdateActions();

    const after = JSON.parse(readFileSync(testStateFile, 'utf-8')) as {
      config: { cliVersion: string };
      auth: { isAuthenticated: boolean };
    };
    expect(after.config.cliVersion).toBe('2.0.0');
    expect(after.auth.isAuthenticated).toBe(true);
  });
});

describe('migrateClaudeCodeHooks', () => {
  let projectRoot: string;

  beforeEach(() => {
    cleanup();
    mkdirSync(testCliDir, { recursive: true });
    projectRoot = join(tmpdir(), `sonar-migrate-test-${Date.now()}`);
    mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    cleanup();
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true });
  });

  it('installs secrets hooks in projectRoot when agentExtensions has a project-level entry', async () => {
    const state = getDefaultState('1.0.0');
    state.agents['claude-code'].configured = true;
    state.agentExtensions = [
      {
        id: randomUUID(),
        agentId: 'claude-code',
        kind: 'hook',
        name: 'sonar-secrets',
        hookType: 'PreToolUse',
        projectRoot,
        global: false,
        updatedByCliVersion: '1.0.0',
        updatedAt: new Date().toISOString(),
      } as HookExtension,
    ];
    writeFileSync(testStateFile, JSON.stringify(state), 'utf-8');

    await runPostUpdateActions();

    const preToolScript = join(
      projectRoot,
      '.claude',
      'hooks',
      'sonar-secrets',
      'build-scripts',
      'pretool-secrets.sh',
    );
    expect(existsSync(preToolScript)).toBe(true);
  });

  it('deduplicates locations — installs hooks once for repeated (projectRoot, globalDir)', async () => {
    const state = getDefaultState('1.0.0');
    state.agents['claude-code'].configured = true;
    const base = {
      agentId: 'claude-code' as const,
      kind: 'hook' as const,
      projectRoot,
      global: false,
      updatedByCliVersion: '1.0.0',
      updatedAt: new Date().toISOString(),
    };
    state.agentExtensions = [
      { ...base, id: randomUUID(), name: 'sonar-secrets', hookType: 'PreToolUse' } as HookExtension,
      {
        ...base,
        id: randomUUID(),
        name: 'sonar-secrets',
        hookType: 'UserPromptSubmit',
      } as HookExtension,
    ];
    writeFileSync(testStateFile, JSON.stringify(state), 'utf-8');

    await runPostUpdateActions();

    // Settings file should exist (written once, not duplicated)
    const settingsPath = join(projectRoot, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks: { PreToolUse: unknown[] };
    };
    // Hooks registered exactly once (not doubled by dedup)
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it('installs hooks in globalDir when extension is marked global', async () => {
    const fakeHome = join(tmpdir(), `sonar-fake-home-${Date.now()}`);
    mkdirSync(fakeHome, { recursive: true });

    const state = getDefaultState('1.0.0');
    state.agents['claude-code'].configured = true;
    state.agentExtensions = [
      {
        id: randomUUID(),
        agentId: 'claude-code',
        kind: 'hook',
        name: 'sonar-secrets',
        hookType: 'PreToolUse',
        projectRoot,
        global: true,
        updatedByCliVersion: '1.0.0',
        updatedAt: new Date().toISOString(),
      } as HookExtension,
    ];
    writeFileSync(testStateFile, JSON.stringify(state), 'utf-8');

    await migrateClaudeCodeHooks(() => fakeHome);

    const preToolScript = join(
      fakeHome,
      '.claude',
      'hooks',
      'sonar-secrets',
      'build-scripts',
      'pretool-secrets.sh',
    );
    expect(existsSync(preToolScript)).toBe(true);

    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('falls back to global homedir migration when registry is empty but old global hooks exist', async () => {
    const fakeHome = join(tmpdir(), `sonar-fake-home-${Date.now()}`);
    const oldHooksDir = join(fakeHome, '.claude', 'hooks', 'sonar-secrets');
    mkdirSync(oldHooksDir, { recursive: true });

    const state = getDefaultState('1.0.0');
    state.agents['claude-code'].configured = true;
    // No agentExtensions — pre-registry format
    writeFileSync(testStateFile, JSON.stringify(state), 'utf-8');

    await migrateClaudeCodeHooks(() => fakeHome);

    // installHooks should have written settings.json under fakeHome/.claude
    const settingsPath = join(fakeHome, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('skips migration when registry is empty and no global hooks exist', async () => {
    const state = getDefaultState('1.0.0');
    state.agents['claude-code'].configured = true;
    // No agentExtensions, no global hooks dir
    writeFileSync(testStateFile, JSON.stringify(state), 'utf-8');

    await runPostUpdateActions();

    // No hooks installed in projectRoot (we never told it where to install)
    expect(existsSync(join(projectRoot, '.claude'))).toBe(false);
  });

  it('skips migration when agent is not configured', async () => {
    const state = getDefaultState('1.0.0');
    // configured = false (default)
    writeFileSync(testStateFile, JSON.stringify(state), 'utf-8');

    await runPostUpdateActions();

    expect(existsSync(join(projectRoot, '.claude'))).toBe(false);
  });
});
