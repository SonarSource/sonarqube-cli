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
  getAllCredentials,
  getToken,
  purgeAllTokens,
  saveToken,
} from '../../../src/lib/keychain.js';

function useFileBackend() {
  let testDir: string;
  let keychainFile: string;
  let savedKeychainFile: string | undefined;
  let savedDisableKeychain: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `keychain-test-${crypto.randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    keychainFile = join(testDir, 'keychain.json');

    savedKeychainFile = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    savedDisableKeychain = process.env.SONARQUBE_CLI_DISABLE_KEYCHAIN;

    process.env.SONARQUBE_CLI_KEYCHAIN_FILE = keychainFile;
    delete process.env.SONARQUBE_CLI_DISABLE_KEYCHAIN;

    clearTokenCache();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });

    if (savedKeychainFile === undefined) {
      delete process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    } else {
      process.env.SONARQUBE_CLI_KEYCHAIN_FILE = savedKeychainFile;
    }

    if (savedDisableKeychain === undefined) {
      delete process.env.SONARQUBE_CLI_DISABLE_KEYCHAIN;
    } else {
      process.env.SONARQUBE_CLI_DISABLE_KEYCHAIN = savedDisableKeychain;
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

describe('SONARQUBE_CLI_DISABLE_KEYCHAIN', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env['SONARQUBE_CLI_DISABLE_KEYCHAIN'];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env['SONARQUBE_CLI_DISABLE_KEYCHAIN'];
    } else {
      process.env['SONARQUBE_CLI_DISABLE_KEYCHAIN'] = saved;
    }
    clearTokenCache();
  });

  it('returns null token when SONARQUBE_CLI_DISABLE_KEYCHAIN is set to true', async () => {
    process.env['SONARQUBE_CLI_DISABLE_KEYCHAIN'] = 'true';
    clearTokenCache();
    const token = await getToken('https://sonarcloud.io', 'myorg');
    expect(token).toBeNull();
  });
});
