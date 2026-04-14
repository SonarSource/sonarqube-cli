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

// Authentication keychain tests (Bun.secrets backend)

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getToken, saveToken, deleteToken, clearTokenCache } from '../../src/lib/keychain.js';
import { createKeychainTestHandle } from './keychain/keychain-test-handle.js';

const handle = createKeychainTestHandle();

describe('Bun.secrets keychain backend', () => {
  beforeEach(() => handle.setup());
  afterEach(async () => handle.teardown());

  describe('account key generation', () => {
    it('generates correct key for SonarCloud with org', async () => {
      await saveToken('https://sonarcloud.io', 'token-org1', 'my-org-1');
      await saveToken('https://sonarcloud.io', 'token-org2', 'my-org-2');

      clearTokenCache();
      expect(await getToken('https://sonarcloud.io', 'my-org-1')).toBe('token-org1');
      expect(await getToken('https://sonarcloud.io', 'my-org-2')).toBe('token-org2');
    });

    it('generates correct key for SonarQube (hostname only)', async () => {
      await saveToken('https://sonarqube1.io', 'token-sq1');
      await saveToken('https://sonarqube2.io', 'token-sq2');

      clearTokenCache();
      expect(await getToken('https://sonarqube1.io')).toBe('token-sq1');
      expect(await getToken('https://sonarqube2.io')).toBe('token-sq2');
    });
  });

  describe('save and get token', () => {
    it('saves and retrieves SonarCloud token with org', async () => {
      await saveToken('https://sonarcloud.io', 'squ_abc123def456', 'my-org');

      clearTokenCache();
      expect(await getToken('https://sonarcloud.io', 'my-org')).toBe('squ_abc123def456');
    });

    it('saves and retrieves SonarQube server token', async () => {
      await saveToken('https://my-sonarqube.io', 'squ_xyz789uvw012');

      clearTokenCache();
      expect(await getToken('https://my-sonarqube.io')).toBe('squ_xyz789uvw012');
    });

    it('returns null for non-existent token', async () => {
      expect(await getToken('https://nonexistent.io', 'no-org')).toBeNull();
    });
  });

  describe('delete token', () => {
    it('removes token from backend', async () => {
      await saveToken('https://sonarcloud.io', 'test-token-123', 'test-org');
      expect(await getToken('https://sonarcloud.io', 'test-org')).toBe('test-token-123');

      await deleteToken('https://sonarcloud.io', 'test-org');
      clearTokenCache();
      expect(await getToken('https://sonarcloud.io', 'test-org')).toBeNull();
    });

    it('does not affect other org tokens', async () => {
      await saveToken('https://sonarcloud.io', 'token-org1', 'org1');
      await saveToken('https://sonarcloud.io', 'token-org2', 'org2');

      await deleteToken('https://sonarcloud.io', 'org1');
      clearTokenCache();
      expect(await getToken('https://sonarcloud.io', 'org1')).toBeNull();
      expect(await getToken('https://sonarcloud.io', 'org2')).toBe('token-org2');
    });
  });

  describe('edge cases', () => {
    it('same server with different orgs have different keys', async () => {
      await saveToken('https://sonarcloud.io', 'token-for-org1', 'org1');
      await saveToken('https://sonarcloud.io', 'token-for-org2', 'org2');

      clearTokenCache();
      const token1 = await getToken('https://sonarcloud.io', 'org1');
      const token2 = await getToken('https://sonarcloud.io', 'org2');
      expect(token1).toBe('token-for-org1');
      expect(token2).toBe('token-for-org2');
      expect(token1).not.toBe(token2);
    });

    it('normalizes URLs with trailing slashes', async () => {
      await saveToken('https://sonarqube.io/', 'test-token');
      clearTokenCache();
      expect(await getToken('https://sonarqube.io')).toBe('test-token');
    });

    it('handles special characters in org names', async () => {
      await saveToken('https://sonarcloud.io', 'token-special', 'my-org_with.special-chars');
      clearTokenCache();
      expect(await getToken('https://sonarcloud.io', 'my-org_with.special-chars')).toBe(
        'token-special',
      );
    });

    it('org parameter is optional for SonarQube', async () => {
      await saveToken('https://sonarqube.io', 'sq-token');
      await saveToken('https://sonarqube.io', 'sq-token', undefined);

      clearTokenCache();
      expect(await getToken('https://sonarqube.io')).toBe('sq-token');
      expect(await getToken('https://sonarqube.io', undefined)).toBe('sq-token');
    });

    it('multiple servers with same org key', async () => {
      await saveToken('https://sonarcloud.io', 'token-sc', 'my-org');
      await saveToken('https://sonarqube.io', 'token-sq');

      clearTokenCache();
      expect(await getToken('https://sonarcloud.io', 'my-org')).toBe('token-sc');
      expect(await getToken('https://sonarqube.io')).toBe('token-sq');
    });
  });
});
