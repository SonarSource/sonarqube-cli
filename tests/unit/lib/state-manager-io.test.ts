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

// Tests for loadState/saveState filesystem I/O and new-agent initialization
// SONARQUBE_CLI_DIR env var redirects state paths to a temporary directory

import { afterAll, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  loadState,
  saveState,
  markAgentConfigured,
  addInstalledHook,
} from '../../../src/lib/state-manager.js';
import { getDefaultState } from '../../../src/lib/state.js';

const testCliDir = join(tmpdir(), `sonar-cli-state-test-${Date.now()}`);
const testStateFile = join(testCliDir, 'state.json');

process.env.SONARQUBE_CLI_DIR = testCliDir;

afterAll(() => {
  delete process.env.SONARQUBE_CLI_DIR;
});

function cleanup(): void {
  if (existsSync(testCliDir)) {
    rmSync(testCliDir, { recursive: true, force: true });
  }
}

// ─── loadState ────────────────────────────────────────────────────────────────

describe('loadState: filesystem I/O', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('creates state dir and returns default state when file does not exist', () => {
    const state = loadState('0.1.0');
    expect(existsSync(testCliDir)).toBe(true);
    expect(state.config.cliVersion).toBe('0.1.0');
    expect(state.auth.isAuthenticated).toBe(false);
  });

  it('returns default state when file contains invalid JSON', () => {
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, 'not-valid-json', 'utf-8');
    const state = loadState('0.2.0');
    expect(state.config.cliVersion).toBe('0.2.0');
  });

  it('returns parsed state when valid state file exists', () => {
    const initial = getDefaultState('0.3.0');
    initial.auth.isAuthenticated = true;
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(initial), 'utf-8');
    const state = loadState('0.3.0');
    expect(state.auth.isAuthenticated).toBe(true);
  });
});

// ─── saveState ────────────────────────────────────────────────────────────────

describe('saveState: filesystem I/O', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('creates state dir and writes state file', () => {
    const state = getDefaultState('0.1.0');
    saveState(state);
    expect(existsSync(testStateFile)).toBe(true);
  });

  it('sets lastUpdated on save', () => {
    const state = getDefaultState('0.1.0');
    const before = new Date().toISOString();
    saveState(state);
    expect(state.lastUpdated >= before).toBe(true);
  });

  it('persists data across save + load cycle', () => {
    const state = getDefaultState('0.3.0');
    state.auth.isAuthenticated = true;
    saveState(state);
    const loaded = loadState('0.3.0');
    expect(loaded.auth.isAuthenticated).toBe(true);
  });
});

// ─── new agent initialization ─────────────────────────────────────────────────

describe('markAgentConfigured: new agent', () => {
  it('initializes missing agent entry before marking configured', () => {
    const state = getDefaultState('0.1.0');
    markAgentConfigured(state, 'new-agent', '0.1.0');
    expect(state.agents['new-agent'].configured).toBe(true);
    expect(state.agents['new-agent'].hooks.installed).toEqual([]);
    expect(state.agents['new-agent'].skills.installed).toEqual([]);
  });
});

describe('addInstalledHook: new agent', () => {
  it('initializes missing agent entry before adding hook', () => {
    const state = getDefaultState('0.1.0');
    addInstalledHook(state, 'new-agent', 'my-hook', 'PostToolUse');
    expect(state.agents['new-agent'].hooks.installed).toHaveLength(1);
    expect(state.agents['new-agent'].hooks.installed[0].name).toBe('my-hook');
  });
});
