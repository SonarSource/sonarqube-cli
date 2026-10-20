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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import {
  clearSecretCache,
  deleteConfigSecret,
  deleteStaleTokens,
  deleteToken,
  generateKeychainAccount,
  getConfigSecret,
  getToken,
  MissingKeychainError,
  normalizeServerUrl,
  saveConfigSecret,
  saveToken,
} from '@/core/host/keychain.ts';

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

    clearSecretCache();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });

    if (savedKeychainFile === undefined) {
      delete process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    } else {
      process.env.SONARQUBE_CLI_KEYCHAIN_FILE = savedKeychainFile;
    }

    clearSecretCache();
  });

  return {
    getKeychainFile: () => keychainFile,
  };
}

describe('token caching', () => {
  const { getKeychainFile } = useFileBackend();

  it('returns cached value without hitting the backend again', async () => {
    await saveToken('https://sonarcloud.io', 'token123');

    writeFileSync(getKeychainFile(), '{ invalid json }');

    const cached = await getToken('https://sonarcloud.io');
    expect(cached).toBe('token123');
  });

  it('caches null when token is not found', async () => {
    const result = await getToken('https://sonarcloud.io');
    expect(result).toBeNull();

    writeFileSync(getKeychainFile(), JSON.stringify({ tokens: { 'sonarcloud.io': 'late-token' } }));
    expect(await getToken('https://sonarcloud.io')).toBeNull();
  });

  it('updates cache on saveToken', async () => {
    await saveToken('https://sonarcloud.io', 'token-v1');
    expect(await getToken('https://sonarcloud.io')).toBe('token-v1');

    await saveToken('https://sonarcloud.io', 'token-v2');
    expect(await getToken('https://sonarcloud.io')).toBe('token-v2');
  });

  it('removes from cache on deleteToken', async () => {
    await saveToken('https://sonarcloud.io', 'token123');
    expect(await getToken('https://sonarcloud.io')).toBe('token123');

    await deleteToken('https://sonarcloud.io');
    expect(await getToken('https://sonarcloud.io')).toBeNull();
  });

  it('clearSecretCache forces re-read from backend', async () => {
    await saveToken('https://sonarcloud.io', 'original');
    expect(await getToken('https://sonarcloud.io')).toBe('original');

    writeFileSync(getKeychainFile(), JSON.stringify({ tokens: { 'sonarcloud.io': 'updated' } }));
    clearSecretCache();

    expect(await getToken('https://sonarcloud.io')).toBe('updated');
  });

  it('caches different accounts independently', async () => {
    await saveToken('https://sonarcloud.io', 'token1');
    await saveToken('https://sonarqube.us', 'token2');
    await saveToken('https://sonarqube.example.com', 'token3');

    writeFileSync(getKeychainFile(), '{ invalid json }');

    expect(await getToken('https://sonarcloud.io')).toBe('token1');
    expect(await getToken('https://sonarqube.us')).toBe('token2');
    expect(await getToken('https://sonarqube.example.com')).toBe('token3');
  });
});

describe('deleteToken', () => {
  useFileBackend();

  it('does not affect other servers when deleting one', async () => {
    await saveToken('https://sonarcloud.io', 'token1');
    await saveToken('https://sonarqube.us', 'token2');

    await deleteToken('https://sonarcloud.io');
    clearSecretCache();

    expect(await getToken('https://sonarcloud.io')).toBeNull();
    expect(await getToken('https://sonarqube.us')).toBe('token2');
  });

  it('silently succeeds when deleting non-existent token', async () => {
    const result = await deleteToken('https://sonarcloud.io');
    expect(result).toBeUndefined();
  });
});

describe('generateKeychainAccount', () => {
  it('returns hostname for a valid SonarCloud URL', () => {
    expect(generateKeychainAccount('https://sonarcloud.io')).toBe('sonarcloud.io');
  });

  it('returns hostname for a valid server URL', () => {
    expect(generateKeychainAccount('https://sonar.example.com')).toBe('sonar.example.com');
  });

  it('returns the raw string when URL parsing fails', () => {
    expect(generateKeychainAccount('not-a-valid-url')).toBe('not-a-valid-url');
  });

  it('strips trailing slash via URL hostname extraction', () => {
    expect(generateKeychainAccount('https://sonar.example.com/')).toBe('sonar.example.com');
  });
});

describe('normalizeServerUrl', () => {
  it.each([
    ['HTTPS://SONAR.EXAMPLE.COM:443/base/', 'https://sonar.example.com/base'],
    ['https://sonar.example.com/base//', 'https://sonar.example.com/base'],
    ['http://sonar.example.com:9000/', 'http://sonar.example.com:9000'],
    ['not-a-valid-url', 'not-a-valid-url'],
  ])('normalizes %s to %s', (serverUrl, expected) => {
    expect(normalizeServerUrl(serverUrl)).toBe(expected);
  });
});

describe('deleteStaleTokens', () => {
  useFileBackend();

  it('deletes token for a replaced connection', async () => {
    await saveToken('https://sonarcloud.io', 'old-token');
    clearSecretCache();

    const oldConnections = [{ serverUrl: 'https://sonarcloud.io' }];
    await deleteStaleTokens(oldConnections, 'https://sonar.company.com');

    expect(await getToken('https://sonarcloud.io')).toBeNull();
  });

  it('preserves token when re-logging into the same server', async () => {
    await saveToken('https://sonarcloud.io', 'my-token');
    clearSecretCache();

    const connections = [{ serverUrl: 'https://sonarcloud.io' }];
    await deleteStaleTokens(connections, 'https://sonarcloud.io');

    expect(await getToken('https://sonarcloud.io')).toBe('my-token');
  });

  it('is a no-op when connections array is empty', async () => {
    await saveToken('https://sonarcloud.io', 'tok');
    clearSecretCache();

    await deleteStaleTokens([], 'https://other.example.com');

    expect(await getToken('https://sonarcloud.io')).toBe('tok');
  });

  it('only deletes the stale connection, not the matching one', async () => {
    await saveToken('https://sonarcloud.io', 'cloud-tok');
    await saveToken('https://sonar.internal.com', 'onprem-tok');
    clearSecretCache();

    const connections = [
      { serverUrl: 'https://sonarcloud.io' },
      { serverUrl: 'https://sonar.internal.com' },
    ];
    await deleteStaleTokens(connections, 'https://sonarcloud.io');

    expect(await getToken('https://sonarcloud.io')).toBe('cloud-tok');
    expect(await getToken('https://sonar.internal.com')).toBeNull();
  });
});

describe('file backend edge cases', () => {
  useFileBackend();

  it('getToken returns null for non-existent token without cache', async () => {
    clearSecretCache();
    expect(await getToken('https://nonexistent.example.com')).toBeNull();
  });

  it('saveToken creates keychain file if it does not exist', async () => {
    await saveToken('https://sonar.example.com', 'new-token');
    clearSecretCache();
    expect(await getToken('https://sonar.example.com')).toBe('new-token');
  });

  it('deleteToken is idempotent for already-deleted tokens', async () => {
    await saveToken('https://sonarcloud.io', 'tok');
    await deleteToken('https://sonarcloud.io');
    await deleteToken('https://sonarcloud.io');
    expect(await getToken('https://sonarcloud.io')).toBeNull();
  });

  it('backend cache is invalidated when SONARQUBE_CLI_KEYCHAIN_FILE changes', async () => {
    await saveToken('https://sonarcloud.io', 'tok-original');

    const altDir = join(tmpdir(), `keychain-alt-${crypto.randomUUID()}`);
    mkdirSync(altDir, { recursive: true });
    const altFile = join(altDir, 'keychain.json');
    writeFileSync(altFile, JSON.stringify({ tokens: { 'sonarcloud.io': 'tok-alt' } }));

    process.env.SONARQUBE_CLI_KEYCHAIN_FILE = altFile;
    clearSecretCache();

    expect(await getToken('https://sonarcloud.io')).toBe('tok-alt');

    rmSync(altDir, { recursive: true, force: true });
  });
});

describe('config secrets', () => {
  const { getKeychainFile } = useFileBackend();

  it('returns a saved secret stored under a config/ account', async () => {
    await saveConfigSecret('network.proxy', 'http://user:pass@proxy:8080');
    clearSecretCache();

    expect(await getConfigSecret('network.proxy')).toBe('http://user:pass@proxy:8080');
    const store = JSON.parse(readFileSync(getKeychainFile(), 'utf-8')) as {
      tokens: Record<string, string>;
    };
    expect(store.tokens).toEqual({ 'config/network.proxy': 'http://user:pass@proxy:8080' });
  });

  it('returns null for an unknown key', async () => {
    expect(await getConfigSecret('missing.key')).toBeNull();
  });

  it('removes a secret on deleteConfigSecret', async () => {
    await saveConfigSecret('network.proxy', 'http://proxy:8080');

    expect(await deleteConfigSecret('network.proxy')).toBe(true);

    expect(await getConfigSecret('network.proxy')).toBeNull();
  });

  it('reports false when deleting a non-existent secret', async () => {
    expect(await deleteConfigSecret('ghost.key')).toBe(false);
  });

  it('does not collide with a token for a server whose hostname equals the config key', async () => {
    const key = 'network.proxy';
    const serverUrl = `https://${key}`;
    const token = 'server-token';
    const secret = 'http://proxy:8080';
    await saveToken(serverUrl, token);
    // A shared account would make this overwrite the token
    await saveConfigSecret(key, secret);
    clearSecretCache();

    expect(await getToken(serverUrl)).toBe(token);
    expect(await getConfigSecret(key)).toBe(secret);

    // Deleting either one must leave the other intact
    await deleteConfigSecret(key);
    clearSecretCache();
    expect(await getToken(serverUrl)).toBe(token);

    await saveConfigSecret(key, secret);
    await deleteToken(serverUrl);
    clearSecretCache();
    expect(await getConfigSecret(key)).toBe(secret);
  });
});

describe('OS keychain unavailable (Bun.secrets backend)', () => {
  let savedKeychainFile: string | undefined;

  beforeEach(() => {
    savedKeychainFile = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    delete process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    clearSecretCache();
  });

  afterEach(() => {
    if (savedKeychainFile !== undefined) {
      process.env.SONARQUBE_CLI_KEYCHAIN_FILE = savedKeychainFile;
    }
    clearSecretCache();
  });

  it('gives repair advice when the OS keychain refuses access', async () => {
    const getSpy = spyOn(Bun.secrets, 'get').mockRejectedValue(new Error('D-Bus not available'));

    try {
      let caught: unknown;
      try {
        await getToken('https://sonarcloud.io');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(CommandFailedError);
      const commandFailedError = caught as CommandFailedError;
      expect(commandFailedError.message).toContain('Failed to access the system keychain.');
      expect(commandFailedError.message).toContain('D-Bus not available');
      expect(commandFailedError).not.toBeInstanceOf(MissingKeychainError);
      expect(commandFailedError.remediationHint).toContain('unlocked');
      expect(commandFailedError.remediationHint).not.toContain('SONARQUBE_CLI_TOKEN');
    } finally {
      getSpy.mockRestore();
    }
  });

  if (process.platform === 'linux') {
    it('gives recovery advice when libsecret cannot be loaded', async () => {
      const getSpy = spyOn(Bun.secrets, 'get').mockRejectedValue(
        new Error('libsecret not available'),
      );

      try {
        let caught: unknown;
        try {
          await getToken('https://sonarcloud.io');
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(MissingKeychainError);
        const missingKeychainError = caught as MissingKeychainError;
        expect(missingKeychainError.message).toStartWith(
          'No usable system keychain is available: libsecret could not be loaded.',
        );
        expect(missingKeychainError.remediationHint).toContain('Install or repair libsecret');
        expect(missingKeychainError.remediationHint).toContain('SONARQUBE_CLI_TOKEN');
        expect(missingKeychainError.remediationHint).toContain('SONARQUBE_CLI_SERVER');
        expect(missingKeychainError.remediationHint).toContain('SONARQUBE_CLI_ORG');
        expect(missingKeychainError.remediationHint).not.toContain('unlocked');
      } finally {
        getSpy.mockRestore();
      }
    });
  }
});
