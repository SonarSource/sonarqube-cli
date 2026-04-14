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

/**
 * Unit tests for the keychain module using the file backend (SONARQUBE_CLI_KEYCHAIN_FILE).
 * Covers token caching, CRUD operations, account key generation, and backend selection.
 * Uses the file backend because these tests need to manipulate the backing store
 * independently of the in-memory cache.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearTokenCache,
  deleteToken,
  generateKeychainAccount,
  getAllCredentials,
  getToken,
  purgeAllTokens,
  saveToken,
} from '../../../src/lib/keychain.js';
import { createKeychainTestHandle } from './keychain-test-handle.js';

function useFileBackend() {
  let testDir: string;
  let keychainFile: string;
  let savedKeychainFile: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `keychain-test-${crypto.randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    keychainFile = join(testDir, 'keychain.json');

    savedKeychainFile = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    process.env.SONARQUBE_CLI_KEYCHAIN_FILE = keychainFile;

    clearTokenCache();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });

    if (savedKeychainFile === undefined) {
      delete process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    } else {
      process.env.SONARQUBE_CLI_KEYCHAIN_FILE = savedKeychainFile;
    }

    clearTokenCache();
  });

  return {
    getKeychainFile: () => keychainFile,
  };
}

describe('token caching', () => {
  const { getKeychainFile } = useFileBackend();

  it('returns cached value without hitting the backend again', async () => {
    await saveToken('https://sonarcloud.io', 'token123', 'myorg');

    writeFileSync(getKeychainFile(), '{ invalid json }');

    const cached = await getToken('https://sonarcloud.io', 'myorg');
    expect(cached).toBe('token123');
  });

  it('caches null when token is not found', async () => {
    const result = await getToken('https://sonarcloud.io', 'missing-org');
    expect(result).toBeNull();

    writeFileSync(
      getKeychainFile(),
      JSON.stringify({ tokens: { 'sonarcloud.io:missing-org': 'late-token' } }),
    );
    expect(await getToken('https://sonarcloud.io', 'missing-org')).toBeNull();
  });

  it('updates cache on saveToken', async () => {
    await saveToken('https://sonarcloud.io', 'token-v1', 'myorg');
    expect(await getToken('https://sonarcloud.io', 'myorg')).toBe('token-v1');

    await saveToken('https://sonarcloud.io', 'token-v2', 'myorg');
    expect(await getToken('https://sonarcloud.io', 'myorg')).toBe('token-v2');
  });

  it('removes from cache on deleteToken', async () => {
    await saveToken('https://sonarcloud.io', 'token123', 'myorg');
    expect(await getToken('https://sonarcloud.io', 'myorg')).toBe('token123');

    await deleteToken('https://sonarcloud.io', 'myorg');
    expect(await getToken('https://sonarcloud.io', 'myorg')).toBeNull();
  });

  it('clearTokenCache forces re-read from backend', async () => {
    await saveToken('https://sonarcloud.io', 'original', 'myorg');
    expect(await getToken('https://sonarcloud.io', 'myorg')).toBe('original');

    writeFileSync(
      getKeychainFile(),
      JSON.stringify({ tokens: { 'sonarcloud.io:myorg': 'updated' } }),
    );
    clearTokenCache();

    expect(await getToken('https://sonarcloud.io', 'myorg')).toBe('updated');
  });

  it('caches different accounts independently', async () => {
    await saveToken('https://sonarcloud.io', 'token1', 'org1');
    await saveToken('https://sonarcloud.io', 'token2', 'org2');
    await saveToken('https://sonarqube.example.com', 'token3');

    writeFileSync(getKeychainFile(), '{ invalid json }');

    expect(await getToken('https://sonarcloud.io', 'org1')).toBe('token1');
    expect(await getToken('https://sonarcloud.io', 'org2')).toBe('token2');
    expect(await getToken('https://sonarqube.example.com')).toBe('token3');
  });
});

describe('deleteToken', () => {
  useFileBackend();

  it('does not affect other tokens when deleting one', async () => {
    await saveToken('https://sonarcloud.io', 'token1', 'org1');
    await saveToken('https://sonarcloud.io', 'token2', 'org2');

    await deleteToken('https://sonarcloud.io', 'org1');
    clearTokenCache();

    expect(await getToken('https://sonarcloud.io', 'org1')).toBeNull();
    expect(await getToken('https://sonarcloud.io', 'org2')).toBe('token2');
  });

  it('silently succeeds when deleting non-existent token', async () => {
    const result = await deleteToken('https://sonarcloud.io', 'ghost-org');
    expect(result).toBeUndefined();
  });
});

describe('getAllCredentials', () => {
  useFileBackend();

  it('returns empty array when keychain file is missing', async () => {
    const credentials = await getAllCredentials();
    expect(credentials).toEqual([]);
  });

  it('returns all saved credentials', async () => {
    await saveToken('https://sonarcloud.io', 'token1', 'org1');
    await saveToken('https://sonarcloud.io', 'token2', 'org2');
    await saveToken('https://sonarqube.example.com', 'token3');

    const credentials = await getAllCredentials();

    expect(credentials).toHaveLength(3);
    const accounts = credentials.map((c) => c.account);
    expect(accounts).toContain('sonarcloud.io:org1');
    expect(accounts).toContain('sonarcloud.io:org2');
    expect(accounts).toContain('sonarqube.example.com');
  });
});

describe('purgeAllTokens', () => {
  useFileBackend();

  it('deletes all tokens and leaves keychain empty', async () => {
    await saveToken('https://sonarcloud.io', 'token1', 'org1');
    await saveToken('https://sonarcloud.io', 'token2', 'org2');

    await purgeAllTokens();

    expect(await getToken('https://sonarcloud.io', 'org1')).toBeNull();
    expect(await getToken('https://sonarcloud.io', 'org2')).toBeNull();
    expect(await getAllCredentials()).toHaveLength(0);
  });

  it('succeeds when there are no tokens', async () => {
    const result = await purgeAllTokens();
    expect(result).toBeUndefined();
    expect(await getAllCredentials()).toHaveLength(0);
  });
});

describe('account key generation', () => {
  useFileBackend();

  it('uses hostname:org format for SonarCloud with org', async () => {
    await saveToken('https://sonarcloud.io', 'token1', 'my-org');
    const credentials = await getAllCredentials();
    expect(credentials[0].account).toBe('sonarcloud.io:my-org');
  });

  it('uses hostname only for SonarQube without org', async () => {
    await saveToken('https://sonarqube.example.com', 'token1');
    const credentials = await getAllCredentials();
    expect(credentials[0].account).toBe('sonarqube.example.com');
  });

  it('uses raw string as key when URL parsing fails', async () => {
    const invalidUrl = 'not-a-valid-url';
    await saveToken(invalidUrl, 'token1');
    const credentials = await getAllCredentials();
    expect(credentials[0].account).toBe(invalidUrl);
  });

  it('isolates tokens by org on the same server', async () => {
    await saveToken('https://sonarcloud.io', 'token-org1', 'org1');
    await saveToken('https://sonarcloud.io', 'token-org2', 'org2');
    clearTokenCache();

    expect(await getToken('https://sonarcloud.io', 'org1')).toBe('token-org1');
    expect(await getToken('https://sonarcloud.io', 'org2')).toBe('token-org2');
  });
});

describe('account index (Bun.secrets backend)', () => {
  const handle = createKeychainTestHandle();

  beforeEach(() => {
    handle.setup();
  });

  afterEach(async () => {
    await handle.teardown();
  });

  it('getAllCredentials returns tokens saved via saveToken', async () => {
    await handle.seedToken('https://sonarcloud.io', 'tok1', 'org1');
    await handle.seedToken('https://sonarcloud.io', 'tok2', 'org2');
    await handle.seedToken('https://server.example.com', 'tok3');

    const creds = await getAllCredentials();
    expect(creds).toHaveLength(3);
    const accounts = creds.map((c) => c.account).sort();
    expect(accounts).toEqual(['server.example.com', 'sonarcloud.io:org1', 'sonarcloud.io:org2']);
  });

  it('getAllCredentials returns empty when nothing was saved', async () => {
    const creds = await getAllCredentials();
    expect(creds).toEqual([]);
  });

  it('deleteToken removes the account from the index', async () => {
    await handle.seedToken('https://sonarcloud.io', 'tok1', 'org1');
    await handle.seedToken('https://sonarcloud.io', 'tok2', 'org2');

    await deleteToken('https://sonarcloud.io', 'org1');
    const creds = await getAllCredentials();
    expect(creds).toHaveLength(1);
    expect(creds[0].account).toBe('sonarcloud.io:org2');
  });

  it('purgeAllTokens removes all tokens and clears the index', async () => {
    await handle.seedToken('https://sonarcloud.io', 'tok1', 'org1');
    await handle.seedToken('https://server.example.com', 'tok2');

    const service = process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE!;

    await purgeAllTokens();

    expect(await getAllCredentials()).toHaveLength(0);
    expect(await getToken('https://sonarcloud.io', 'org1')).toBeNull();
    expect(await getToken('https://server.example.com')).toBeNull();

    const directLookup1 = await Bun.secrets.get({ service, name: 'sonarcloud.io:org1' });
    const directLookup2 = await Bun.secrets.get({ service, name: 'server.example.com' });
    expect(directLookup1).toBeNull();
    expect(directLookup2).toBeNull();
  });

  it('does not duplicate accounts on repeated saves', async () => {
    await handle.seedToken('https://sonarcloud.io', 'v1', 'org1');
    clearTokenCache();
    await handle.saveToken('https://sonarcloud.io', 'v2', 'org1');

    const creds = await getAllCredentials();
    expect(creds).toHaveLength(1);
    expect(creds[0].password).toBe('v2');
  });

  it('handles orphaned index entries gracefully', async () => {
    await handle.seedToken('https://sonarcloud.io', 'tok1', 'org1');

    // Manually delete the credential from Bun.secrets without going through deleteToken
    const service = process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE!;
    await Bun.secrets.delete({ service, name: 'sonarcloud.io:org1' });

    clearTokenCache();
    const creds = await getAllCredentials();
    expect(creds).toHaveLength(0);
  });
});

describe('SONARQUBE_CLI_KEYCHAIN_SERVICE', () => {
  const handle = createKeychainTestHandle();

  beforeEach(() => handle.setup());
  afterEach(async () => handle.teardown());

  it('uses the env var as the service name for token isolation', async () => {
    await handle.saveToken('https://sonarcloud.io', 'token-a', 'org-a');

    const account = generateKeychainAccount('https://sonarcloud.io', 'org-a');
    const stored = await Bun.secrets.get({
      service: process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE!,
      name: account,
    });
    expect(stored).toBe('token-a');
  });

  it('tokens written under one service name are invisible to another', async () => {
    await handle.saveToken('https://sonarcloud.io', 'token-a', 'org-a');

    const account = generateKeychainAccount('https://sonarcloud.io', 'org-a');
    const fromOtherService = await Bun.secrets.get({
      service: 'nonexistent-service',
      name: account,
    });
    expect(fromOtherService).toBeNull();
  });
});
