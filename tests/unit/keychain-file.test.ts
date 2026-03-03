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

/**
 * Unit tests for file-based keychain (SONAR_CLI_KEYCHAIN_FILE).
 * Exercises createFileKeytar, generateKeychainAccount, and all public API
 * functions through the real implementation — no keytar mocking needed.
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
} from '../../src/lib/keychain.js';

describe('File-based keychain', () => {
  let testDir: string;
  let keychainFile: string;
  let savedKeychainFile: string | undefined;
  let savedDisableKeychain: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `keychain-file-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    keychainFile = join(testDir, 'keychain.json');

    savedKeychainFile = process.env.SONAR_CLI_KEYCHAIN_FILE;
    savedDisableKeychain = process.env.SONAR_CLI_DISABLE_KEYCHAIN;

    process.env.SONAR_CLI_KEYCHAIN_FILE = keychainFile;
    delete process.env.SONAR_CLI_DISABLE_KEYCHAIN;

    clearTokenCache();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });

    if (savedKeychainFile === undefined) {
      delete process.env.SONAR_CLI_KEYCHAIN_FILE;
    } else {
      process.env.SONAR_CLI_KEYCHAIN_FILE = savedKeychainFile;
    }

    if (savedDisableKeychain === undefined) {
      delete process.env.SONAR_CLI_DISABLE_KEYCHAIN;
    } else {
      process.env.SONAR_CLI_DISABLE_KEYCHAIN = savedDisableKeychain;
    }

    clearTokenCache();
  });

  describe('saveToken and getToken', () => {
    it('should persist token to file and retrieve it after cache clear', async () => {
      // Arrange
      await saveToken('https://sonarcloud.io', 'squ_test_token', 'my-org');

      // Act — clear cache to force file read
      clearTokenCache();
      const result = await getToken('https://sonarcloud.io', 'my-org');

      // Assert
      expect(result).toBe('squ_test_token');
    });

    it('should return cached value on second call without re-reading file', async () => {
      // Arrange
      await saveToken('https://sonarcloud.io', 'original-token', 'my-org');

      // Corrupt the file — cache should be used and return original value
      writeFileSync(keychainFile, '{ invalid json }');

      // Act
      const result = await getToken('https://sonarcloud.io', 'my-org');

      // Assert — original value from cache, not corrupt file
      expect(result).toBe('original-token');
    });

    it('should return null when token is not in file or cache', async () => {
      // Act — no file written yet, missing file handled by readStore catch
      const result = await getToken('https://sonarcloud.io', 'nonexistent-org');

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when keychain file is corrupt (readStore error branch)', async () => {
      // Arrange
      writeFileSync(keychainFile, '{ not valid json }');

      // Act
      const result = await getToken('https://sonarcloud.io', 'my-org');

      // Assert
      expect(result).toBeNull();
    });

    it('should overwrite token when saved again for same account', async () => {
      // Arrange
      await saveToken('https://sonarcloud.io', 'token-v1', 'my-org');
      await saveToken('https://sonarcloud.io', 'token-v2', 'my-org');

      // Act — clear cache to read from file
      clearTokenCache();
      const result = await getToken('https://sonarcloud.io', 'my-org');

      // Assert
      expect(result).toBe('token-v2');
    });
  });

  describe('deleteToken', () => {
    it('should remove token from file and return null after cache clear', async () => {
      // Arrange
      await saveToken('https://sonarcloud.io', 'token123', 'my-org');

      // Act
      await deleteToken('https://sonarcloud.io', 'my-org');
      clearTokenCache();
      const result = await getToken('https://sonarcloud.io', 'my-org');

      // Assert
      expect(result).toBeNull();
    });

    it('should not affect other tokens when deleting one', async () => {
      // Arrange
      await saveToken('https://sonarcloud.io', 'token1', 'org1');
      await saveToken('https://sonarcloud.io', 'token2', 'org2');

      // Act
      await deleteToken('https://sonarcloud.io', 'org1');
      clearTokenCache();

      // Assert
      expect(await getToken('https://sonarcloud.io', 'org1')).toBeNull();
      expect(await getToken('https://sonarcloud.io', 'org2')).toBe('token2');
    });

    it('should silently succeed when deleting non-existent token', async () => {
      // Act & Assert — deletePassword false branch, must not throw
      const result = await deleteToken('https://sonarcloud.io', 'ghost-org');
      expect(result).toBeUndefined();
    });
  });

  describe('getAllCredentials', () => {
    it('should return empty array when keychain file is missing', async () => {
      // Act
      const credentials = await getAllCredentials();

      // Assert
      expect(credentials).toEqual([]);
    });

    it('should return all saved credentials', async () => {
      // Arrange
      await saveToken('https://sonarcloud.io', 'token1', 'org1');
      await saveToken('https://sonarcloud.io', 'token2', 'org2');
      await saveToken('https://sonarqube.example.com', 'token3');

      // Act
      const credentials = await getAllCredentials();

      // Assert
      expect(credentials).toHaveLength(3);
      const accounts = credentials.map((c) => c.account);
      expect(accounts).toContain('sonarcloud.io:org1');
      expect(accounts).toContain('sonarcloud.io:org2');
      expect(accounts).toContain('sonarqube.example.com');
    });
  });

  describe('purgeAllTokens', () => {
    it('should delete all tokens and leave keychain empty', async () => {
      // Arrange
      await saveToken('https://sonarcloud.io', 'token1', 'org1');
      await saveToken('https://sonarcloud.io', 'token2', 'org2');

      // Act
      await purgeAllTokens();

      // Assert — verify both cache and file are cleared
      expect(await getToken('https://sonarcloud.io', 'org1')).toBeNull();
      expect(await getToken('https://sonarcloud.io', 'org2')).toBeNull();
      expect(await getAllCredentials()).toHaveLength(0);
    });

    it('should succeed when there are no tokens', async () => {
      // Act & Assert
      const result = await purgeAllTokens();
      expect(result).toBeUndefined();
      expect(await getAllCredentials()).toHaveLength(0);
    });
  });

  describe('clearTokenCache', () => {
    it('should force re-read from file on next getToken call', async () => {
      // Arrange — save initial token
      await saveToken('https://sonarcloud.io', 'old-token', 'my-org');

      // Manually update the file to simulate an external change
      const store = { tokens: { 'sonarcloud.io:my-org': 'new-token' } };
      writeFileSync(keychainFile, JSON.stringify(store));

      // Act — clear cache to pick up file change
      clearTokenCache();
      const result = await getToken('https://sonarcloud.io', 'my-org');

      // Assert
      expect(result).toBe('new-token');
    });
  });

  describe('account key generation (generateKeychainAccount)', () => {
    it('should use hostname:org format for SonarCloud with org', async () => {
      // Arrange
      await saveToken('https://sonarcloud.io', 'token1', 'my-org');
      clearTokenCache();

      // Act
      const result = await getToken('https://sonarcloud.io', 'my-org');

      // Assert — account stored as "sonarcloud.io:my-org"
      expect(result).toBe('token1');
      const credentials = await getAllCredentials();
      expect(credentials[0].account).toBe('sonarcloud.io:my-org');
    });

    it('should use hostname only for SonarQube without org', async () => {
      // Arrange
      await saveToken('https://sonarqube.example.com', 'token1');
      clearTokenCache();

      // Act
      const result = await getToken('https://sonarqube.example.com');

      // Assert — account stored as hostname only
      expect(result).toBe('token1');
      const credentials = await getAllCredentials();
      expect(credentials[0].account).toBe('sonarqube.example.com');
    });

    it('should use raw string as key when URL parsing fails', async () => {
      // Arrange — invalid URL triggers catch branch in generateKeychainAccount
      const invalidUrl = 'not-a-valid-url';
      await saveToken(invalidUrl, 'token1');
      clearTokenCache();

      // Act
      const result = await getToken(invalidUrl);

      // Assert — raw URL used as account key
      expect(result).toBe('token1');
      const credentials = await getAllCredentials();
      expect(credentials[0].account).toBe(invalidUrl);
    });

    it('should isolate tokens by org on the same server', async () => {
      // Arrange
      await saveToken('https://sonarcloud.io', 'token-org1', 'org1');
      await saveToken('https://sonarcloud.io', 'token-org2', 'org2');
      clearTokenCache();

      // Act & Assert — different orgs → different accounts → different tokens
      expect(await getToken('https://sonarcloud.io', 'org1')).toBe('token-org1');
      expect(await getToken('https://sonarcloud.io', 'org2')).toBe('token-org2');
    });
  });
});
