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

// Unit tests for the centralized auth resolver

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { resolveAuth, ENV_TOKEN, ENV_SERVER } from '../../src/lib/auth-resolver.js';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';
import { setMockUi } from '../../src/ui';
import { createMockKeytar } from './helpers/mock-keytar.js';

const SONARCLOUD_URL = 'https://sonarcloud.io';
const FAKE_TOKEN = 'squ_test_token_abc123';
const FAKE_TOKEN_ENV = 'squ_env_token_xyz789';

const keytarHandle = createMockKeytar();

describe('resolveAuth', () => {
  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    // Ensure env vars are clean
    delete process.env[ENV_TOKEN];
    delete process.env[ENV_SERVER];
  });

  afterEach(() => {
    keytarHandle.teardown();
    setMockUi(false);
    delete process.env[ENV_TOKEN];
    delete process.env[ENV_SERVER];
  });

  // ─── Env var: both set ──────────────────────────────────────────────────

  describe('when both env vars are set', () => {
    beforeEach(() => {
      process.env[ENV_TOKEN] = FAKE_TOKEN_ENV;
      process.env[ENV_SERVER] = SONARCLOUD_URL;
    });

    it('returns env token and server immediately', async () => {
      const result = await resolveAuth();

      expect(result).not.toBeNull();
      expect(result!.token).toBe(FAKE_TOKEN_ENV);
      expect(result!.serverUrl).toBe(SONARCLOUD_URL);
    });

    it('skips keychain lookup entirely', async () => {
      const loadStateSpy = spyOn(stateManager, 'loadState');
      try {
        await resolveAuth();
        expect(loadStateSpy).not.toHaveBeenCalled();
      } finally {
        loadStateSpy.mockRestore();
      }
    });
  });

  // ─── Env var: partial ──────────────────────────────────────────────────

  describe('when only one env var is set', () => {
    it('warns when only ENV_TOKEN is set and falls back', async () => {
      process.env[ENV_TOKEN] = FAKE_TOKEN_ENV;
      const state = getDefaultState('test');
      state.auth.connections = [
        {
          id: 'conn-1',
          type: 'cloud',
          serverUrl: SONARCLOUD_URL,
          orgKey: 'my-org',
          authenticatedAt: new Date().toISOString(),
          keystoreKey: 'sonarcloud.io:my-org',
        },
      ];
      state.auth.activeConnectionId = 'conn-1';
      state.auth.isAuthenticated = true;

      const loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(state);
      await keytarHandle.mock.setPassword('sonarqube-cli', 'sonarcloud.io:my-org', FAKE_TOKEN);

      try {
        const result = await resolveAuth();
        expect(result).toMatchObject({
          token: FAKE_TOKEN,
          serverUrl: SONARCLOUD_URL,
        });
      } finally {
        loadStateSpy.mockRestore();
      }
    });

    it('warns when only ENV_SERVER is set and falls back', async () => {
      process.env[ENV_SERVER] = SONARCLOUD_URL;
      const state = getDefaultState('test');
      state.auth.connections = [
        {
          id: 'conn-1',
          type: 'cloud',
          serverUrl: SONARCLOUD_URL,
          orgKey: 'my-org',
          authenticatedAt: new Date().toISOString(),
          keystoreKey: 'sonarcloud.io:my-org',
        },
      ];
      state.auth.activeConnectionId = 'conn-1';
      state.auth.isAuthenticated = true;

      const loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(state);
      await keytarHandle.mock.setPassword('sonarqube-cli', 'sonarcloud.io:my-org', FAKE_TOKEN);

      try {
        const result = await resolveAuth();
        expect(result).toMatchObject({
          token: FAKE_TOKEN,
          serverUrl: SONARCLOUD_URL,
        });
      } finally {
        loadStateSpy.mockRestore();
      }
    });
  });

  // ─── Active connection in state ────────────────────────────────────────

  describe('when active connection exists in state', () => {
    it('resolves server + token from state + keychain', async () => {
      const state = getDefaultState('test');
      state.auth.connections = [
        {
          id: 'conn-1',
          type: 'cloud',
          serverUrl: SONARCLOUD_URL,
          orgKey: 'my-org',
          authenticatedAt: new Date().toISOString(),
          keystoreKey: 'sonarcloud.io:my-org',
        },
      ];
      state.auth.activeConnectionId = 'conn-1';
      state.auth.isAuthenticated = true;

      const loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(state);

      // Seed keychain with token for sonarcloud.io:my-org
      await keytarHandle.mock.setPassword('sonarqube-cli', 'sonarcloud.io:my-org', FAKE_TOKEN);

      try {
        const result = await resolveAuth();
        expect(result).not.toBeNull();
        expect(result!.token).toBe(FAKE_TOKEN);
        expect(result!.serverUrl).toBe(SONARCLOUD_URL);
        expect(result!.orgKey).toBe('my-org');
      } finally {
        loadStateSpy.mockRestore();
      }
    });
  });

  // ─── No auth found ─────────────────────────────────────────────────────

  describe('when no auth is available', () => {
    it('returns null when no server can be resolved', async () => {
      const loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(
        getDefaultState('test'),
      );

      try {
        const result = await resolveAuth();
        expect(result).toBeNull();
      } finally {
        loadStateSpy.mockRestore();
      }
    });
  });

  // ─── ENV_TOKEN / ENV_SERVER constants ─────────────────────────────────

  it('exports ENV_TOKEN constant', () => {
    expect(ENV_TOKEN).toBe('SONAR_CLI_TOKEN');
  });

  it('exports ENV_SERVER constant', () => {
    expect(ENV_SERVER).toBe('SONAR_CLI_SERVER');
  });
});
