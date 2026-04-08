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
import { saveToken, getToken } from '../../src/cli/commands/_common/token';
import * as token from '../../src/cli/commands/_common/token';
import { authLogin } from '../../src/cli/commands/auth/login';
import { authLogout } from '../../src/cli/commands/auth/logout';
import { authPurge } from '../../src/cli/commands/auth/purge';
import { authStatus } from '../../src/cli/commands/auth/status';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import * as discovery from '../../src/lib/project-workspace';
import { setMockUi } from '../../src/ui';
import { createMockKeytar } from './helpers/mock-keytar.js';
import * as stateManager from '../../src/lib/state-manager.js';
import type { AuthConnection } from '../../src/lib/state.js';
import { getDefaultState } from '../../src/lib/state.js';
import { ResolvedAuth } from '../../src/lib/auth-resolver.js';

const keytarHandle = createMockKeytar();

function cliStateWithLoggedInConnection(auth: ResolvedAuth): ReturnType<typeof getDefaultState> {
  const base = getDefaultState('test');
  const connectionId = stateManager.generateConnectionId(auth.serverUrl, auth.orgKey);
  const connection: AuthConnection = {
    id: connectionId,
    type: auth.connectionType === 'cloud' ? 'cloud' : 'on-premise',
    serverUrl: auth.serverUrl,
    authenticatedAt: new Date().toISOString(),
    keystoreKey: 'test',
  };
  if (auth.orgKey !== undefined) {
    connection.orgKey = auth.orgKey;
  }
  return {
    ...base,
    auth: {
      isAuthenticated: true,
      connections: [connection],
      activeConnectionId: connectionId,
    },
  };
}

describe('authLogoutCommand', () => {
  let loadStateSpy: any;

  let saveStateSpy: any;

  const FAKE_SQS_AUTH: ResolvedAuth = {
    token: 'fake-token',
    serverUrl: 'https://sonar.example.com',
    connectionType: 'on-premise',
  };

  const FAKE_SQC_AUTH: ResolvedAuth = {
    serverUrl: 'https://sonarcloud.io',
    token: 'fake-token',
    orgKey: 'test-org',
    connectionType: 'cloud',
  };

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    loadStateSpy = spyOn(stateManager, 'loadState').mockImplementation(() =>
      cliStateWithLoggedInConnection(FAKE_SQS_AUTH),
    );
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
  });

  afterEach(() => {
    keytarHandle.teardown();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('deletes on-premise token from keychain on logout', async () => {
    loadStateSpy.mockImplementation(() => cliStateWithLoggedInConnection(FAKE_SQS_AUTH));
    await saveToken(FAKE_SQS_AUTH.serverUrl, FAKE_SQS_AUTH.token);
    expect(await getToken(FAKE_SQS_AUTH.serverUrl)).toBe(FAKE_SQS_AUTH.token);

    await authLogout();

    expect(await getToken(FAKE_SQS_AUTH.serverUrl)).toBeNull();
  });

  it('deletes SonarCloud token when org provided', async () => {
    loadStateSpy.mockImplementation(() => cliStateWithLoggedInConnection(FAKE_SQC_AUTH));
    await saveToken(FAKE_SQC_AUTH.serverUrl, FAKE_SQC_AUTH.token, FAKE_SQC_AUTH.orgKey);
    expect(await getToken(FAKE_SQC_AUTH.serverUrl, FAKE_SQC_AUTH.orgKey)).toBe(FAKE_SQC_AUTH.token);

    await authLogout();

    expect(await getToken(FAKE_SQC_AUTH.serverUrl, FAKE_SQC_AUTH.orgKey)).toBeNull();
  });

  it('does not delete other org tokens when logging out from one org', async () => {
    loadStateSpy.mockImplementation(() => cliStateWithLoggedInConnection(FAKE_SQC_AUTH));
    await saveToken(FAKE_SQC_AUTH.serverUrl, FAKE_SQC_AUTH.token, FAKE_SQC_AUTH.orgKey);
    await saveToken(FAKE_SQC_AUTH.serverUrl, 'token-org2', 'org2');

    await authLogout();

    expect(await getToken(FAKE_SQC_AUTH.serverUrl, FAKE_SQC_AUTH.orgKey)).toBeNull();
    expect(await getToken(FAKE_SQC_AUTH.serverUrl, 'org2')).toBe('token-org2');
  });

  it('accepts on-premise server with org (org is optional for on-premise)', async () => {
    loadStateSpy.mockImplementation(() => cliStateWithLoggedInConnection(FAKE_SQS_AUTH));
    await saveToken(FAKE_SQS_AUTH.serverUrl, FAKE_SQS_AUTH.token);

    await authLogout();

    expect(await getToken(FAKE_SQS_AUTH.serverUrl)).toBeNull();
  });

  it('does not touch keychain when state has no active session', async () => {
    loadStateSpy.mockReturnValue(getDefaultState('test'));
    const deleteSpy = spyOn(token, 'deleteToken').mockResolvedValue(undefined);
    await saveToken(FAKE_SQS_AUTH.serverUrl, FAKE_SQS_AUTH.token);

    await authLogout();

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await getToken(FAKE_SQS_AUTH.serverUrl)).toBe(FAKE_SQS_AUTH.token);
    deleteSpy.mockRestore();
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
  sonarLintConfigPath: null,
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
    discoverSpy = spyOn(discovery, 'discoverProjectInfo').mockResolvedValue(EMPTY_PROJECT_INFO);
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
    const saveTokenSpy = spyOn(token, 'saveToken').mockRejectedValue(
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
    const browserSpy = spyOn(token, 'generateTokenViaBrowser').mockResolvedValue('browser-token');
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
    const browserSpy = spyOn(token, 'generateTokenViaBrowser').mockResolvedValue('browser-token');
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
    const browserSpy = spyOn(token, 'generateTokenViaBrowser').mockResolvedValue('browser-token');
    try {
      // No options — defaults to SonarCloud, org picked from config, browser flow
      await authLogin({});
      expect(await getToken('https://sonarcloud.io', 'my-org')).toBe('browser-token');
    } finally {
      browserSpy.mockRestore();
    }
  });

  it('throws when browser authentication fails', () => {
    const browserSpy = spyOn(token, 'generateTokenViaBrowser').mockRejectedValue(
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
