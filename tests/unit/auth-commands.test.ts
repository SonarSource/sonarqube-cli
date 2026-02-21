// Tests for src/commands/auth.ts exported functions

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { saveToken, getToken } from '../../src/bootstrap/auth.js';
import { authLoginCommand, authLogoutCommand, authPurgeCommand, authListCommand } from '../../src/commands/auth.js';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui';
import { createMockKeytar } from '../helpers/mock-keytar.js';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';

const keytarHandle = createMockKeytar();

describe('authLogoutCommand', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockExit: any;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    keytarHandle.teardown();
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when SonarCloud server used without org', async () => {
    await authLogoutCommand({ server: 'https://sonarcloud.io' });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('logs info and exits 0 when no token found for on-premise server', async () => {
    clearMockUiCalls();

    await authLogoutCommand({ server: 'https://sonar.example.com' });

    const calls = getMockUiCalls();
    const printCalls = calls.filter(c => c.method === 'print').map(c => String(c.args[0]));
    expect(printCalls.some(m => m.includes('No token found'))).toBe(true);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('deletes on-premise token from keychain on logout', async () => {
    await saveToken('https://sonar.example.com', 'test-token-xyz');
    expect(await getToken('https://sonar.example.com')).toBe('test-token-xyz');

    await authLogoutCommand({ server: 'https://sonar.example.com' });

    expect(await getToken('https://sonar.example.com')).toBeNull();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('deletes SonarCloud token when org provided', async () => {
    await saveToken('https://sonarcloud.io', 'cloud-token-abc', 'my-org');
    expect(await getToken('https://sonarcloud.io', 'my-org')).toBe('cloud-token-abc');

    await authLogoutCommand({ server: 'https://sonarcloud.io', org: 'my-org' });

    expect(await getToken('https://sonarcloud.io', 'my-org')).toBeNull();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('does not delete other org tokens when logging out from one org', async () => {
    await saveToken('https://sonarcloud.io', 'token-org1', 'org1');
    await saveToken('https://sonarcloud.io', 'token-org2', 'org2');

    await authLogoutCommand({ server: 'https://sonarcloud.io', org: 'org1' });

    expect(await getToken('https://sonarcloud.io', 'org1')).toBeNull();
    expect(await getToken('https://sonarcloud.io', 'org2')).toBe('token-org2');
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('accepts on-premise server with org (org is optional for on-premise)', async () => {
    await saveToken('https://sonar.example.com', 'onprem-token');

    await authLogoutCommand({ server: 'https://sonar.example.com', org: 'some-org' });

    expect(mockExit).toHaveBeenCalledWith(0);
  });
});

describe('authPurgeCommand', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockExit: any;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    keytarHandle.teardown();
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('exits 0 when keychain is empty', async () => {
    await authPurgeCommand();
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});

describe('authListCommand', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockExit: any;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    keytarHandle.teardown();
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('exits 0 when no saved connections', async () => {
    await authListCommand();
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});

describe('authLoginCommand', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockExit: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let loadStateSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let saveStateSpy: any;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
  });

  afterEach(() => {
    keytarHandle.teardown();
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('exits 0 when token saved for on-premise server with --with-token', async () => {
    await authLoginCommand({ server: 'https://sonar.example.com', org: 'test-org', withToken: 'test-token-xyz' });
    expect(await getToken('https://sonar.example.com', 'test-org')).toBe('test-token-xyz');
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});
