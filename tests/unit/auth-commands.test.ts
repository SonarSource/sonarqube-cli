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

// Tests for src/commands/auth.ts exported functions

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { saveToken, getToken } from '../../src/bootstrap/auth.js';
import * as authBootstrap from '../../src/bootstrap/auth.js';
import { authLogin, authLogout, authPurge, authStatus } from '../../src/cli/commands/auth.js';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import * as discovery from '../../src/bootstrap/discovery.js';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui';
import { createMockKeytar } from '../helpers/mock-keytar.js';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';

const keytarHandle = createMockKeytar();

describe('authLogoutCommand', () => {
  let loadStateSpy: any;

  let saveStateSpy: any;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
  });

  afterEach(() => {
    keytarHandle.teardown();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('throws when SonarCloud server used without org', () => {
    expect(authLogout({ server: 'https://sonarcloud.io' })).rejects.toThrow();
  });

  it('logs info and exits 0 when no token found for on-premise server', async () => {
    clearMockUiCalls();

    await authLogout({ server: 'https://sonar.example.com' });

    const calls = getMockUiCalls();
    const printCalls = calls.filter((c) => c.method === 'print').map((c) => String(c.args[0]));
    expect(printCalls.some((m) => m.includes('No token found'))).toBe(true);
  });

  it('deletes on-premise token from keychain on logout', async () => {
    await saveToken('https://sonar.example.com', 'test-token-xyz');
    expect(await getToken('https://sonar.example.com')).toBe('test-token-xyz');

    await authLogout({ server: 'https://sonar.example.com' });

    expect(await getToken('https://sonar.example.com')).toBeNull();
  });

  it('deletes SonarCloud token when org provided', async () => {
    await saveToken('https://sonarcloud.io', 'cloud-token-abc', 'my-org');
    expect(await getToken('https://sonarcloud.io', 'my-org')).toBe('cloud-token-abc');

    await authLogout({ server: 'https://sonarcloud.io', org: 'my-org' });

    expect(await getToken('https://sonarcloud.io', 'my-org')).toBeNull();
  });

  it('does not delete other org tokens when logging out from one org', async () => {
    await saveToken('https://sonarcloud.io', 'token-org1', 'org1');
    await saveToken('https://sonarcloud.io', 'token-org2', 'org2');

    await authLogout({ server: 'https://sonarcloud.io', org: 'org1' });

    expect(await getToken('https://sonarcloud.io', 'org1')).toBeNull();
    expect(await getToken('https://sonarcloud.io', 'org2')).toBe('token-org2');
  });

  it('accepts on-premise server with org (org is optional for on-premise)', async () => {
    await saveToken('https://sonar.example.com', 'onprem-token');

    await authLogout({ server: 'https://sonar.example.com', org: 'some-org' });
  });
});

describe('authPurgeCommand', () => {
  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
  });

  afterEach(() => {
    keytarHandle.teardown();
    setMockUi(false);
  });

  it('can purge when keychain is empty', async () => {
    await authPurge();
  });
});

describe('authStatusCommand', () => {
  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
  });

  afterEach(() => {
    keytarHandle.teardown();
    setMockUi(false);
  });

  it('can get status when no saved connections', async () => {
    await authStatus();
  });
});

const EMPTY_PROJECT_INFO = {
  root: '',
  name: '',
  isGitRepo: false,
  gitRemote: '',
  hasSonarProps: false,
  sonarPropsData: null,
  hasSonarLintConfig: false,
  sonarLintData: null,
};

describe('authLoginCommand', () => {
  let loadStateSpy: any;

  let saveStateSpy: any;
  let discoverSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
    discoverSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(EMPTY_PROJECT_INFO);
  });

  afterEach(() => {
    keytarHandle.teardown();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    discoverSpy.mockRestore();
    setMockUi(false);
  });

  it('exits 0 when token saved for on-premise server with --with-token', async () => {
    const getSystemStatusSpy = spyOn(
      SonarQubeClient.prototype,
      'getSystemStatus',
    ).mockResolvedValue({ status: 'UP', version: '10.0' });
    try {
      await authLogin({
        server: 'https://sonar.example.com',
        org: 'test-org',
        withToken: 'test-token-xyz',
      });
      expect(await getToken('https://sonar.example.com', 'test-org')).toBe('test-token-xyz');
    } finally {
      getSystemStatusSpy.mockRestore();
    }
  });

  it('exits 0 when token saved for SonarCloud with --with-token and valid org', async () => {
    const checkOrgSpy = spyOn(SonarQubeClient.prototype, 'checkOrganization').mockResolvedValue(
      true,
    );
    try {
      await authLogin({ withToken: 'cloud-token', org: 'my-org' });
      expect(await getToken('https://sonarcloud.io', 'my-org')).toBe('cloud-token');
    } finally {
      checkOrgSpy.mockRestore();
    }
  });

  it('throws when SonarCloud --with-token used without org', () => {
    expect(authLogin({ withToken: 'cloud-token' })).rejects.toThrow();
  });

  it('throws when SonarCloud org not found', () => {
    const checkOrgSpy = spyOn(SonarQubeClient.prototype, 'checkOrganization').mockResolvedValue(
      false,
    );
    try {
      expect(authLogin({ withToken: 'cloud-token', org: 'nonexistent-org' })).rejects.toThrow();
    } finally {
      checkOrgSpy.mockRestore();
    }
  });

  it('throws when saving token to keychain fails', () => {
    const saveTokenSpy = spyOn(authBootstrap, 'saveToken').mockRejectedValue(
      new Error('Keychain access denied'),
    );
    try {
      expect(
        authLogin({ server: 'https://sonar.example.com', withToken: 'test-token' }),
      ).rejects.toThrow();
    } finally {
      saveTokenSpy.mockRestore();
    }
  });

  it('exits 0 when browser login succeeds for on-premise server', async () => {
    const browserSpy = spyOn(authBootstrap, 'generateTokenViaBrowser').mockResolvedValue(
      'browser-token',
    );
    const getSystemStatusSpy = spyOn(
      SonarQubeClient.prototype,
      'getSystemStatus',
    ).mockResolvedValue({ status: 'UP', version: '10.0' });
    try {
      await authLogin({ server: 'https://sonar.example.com' });
      expect(await getToken('https://sonar.example.com')).toBe('browser-token');
    } finally {
      browserSpy.mockRestore();
      getSystemStatusSpy.mockRestore();
    }
  });

  it('exits 0 when browser login succeeds for SonarCloud with org', async () => {
    const browserSpy = spyOn(authBootstrap, 'generateTokenViaBrowser').mockResolvedValue(
      'browser-token',
    );
    const checkOrgSpy = spyOn(SonarQubeClient.prototype, 'checkOrganization').mockResolvedValue(
      true,
    );
    try {
      await authLogin({ org: 'my-org' });
      expect(await getToken('https://sonarcloud.io', 'my-org')).toBe('browser-token');
    } finally {
      browserSpy.mockRestore();
      checkOrgSpy.mockRestore();
    }
  });

  it('exits 0 when org auto-detected from project config and browser login succeeds', async () => {
    // Simulate sonar-project.properties with organization set
    discoverSpy.mockResolvedValue({
      ...EMPTY_PROJECT_INFO,
      hasSonarProps: true,
      sonarPropsData: {
        hostURL: '',
        projectKey: 'my-project',
        projectName: 'My Project',
        organization: 'my-org',
      },
    });
    const browserSpy = spyOn(authBootstrap, 'generateTokenViaBrowser').mockResolvedValue(
      'browser-token',
    );
    try {
      // No options — defaults to SonarCloud, org picked from config, browser flow
      await authLogin({});
      expect(await getToken('https://sonarcloud.io', 'my-org')).toBe('browser-token');
    } finally {
      browserSpy.mockRestore();
    }
  });

  it('throws when browser authentication fails', () => {
    const browserSpy = spyOn(authBootstrap, 'generateTokenViaBrowser').mockRejectedValue(
      new Error('Authentication cancelled'),
    );
    try {
      expect(authLogin({ server: 'https://sonar.example.com' })).rejects.toThrow();
    } finally {
      browserSpy.mockRestore();
    }
  });

  it('throws when --org is empty string', () => {
    expect(authLogin({ org: '' })).rejects.toThrow();
  });

  it('throws when --with-token is empty string', () => {
    expect(authLogin({ withToken: '' })).rejects.toThrow();
  });

  it('throws when --server is empty string', () => {
    expect(authLogin({ server: '' })).rejects.toThrow();
  });

  it('throws when --server is not a valid URL', () => {
    expect(authLogin({ server: 'not-a-url', withToken: 'tok', org: 'my-org' })).rejects.toThrow();
  });
});
