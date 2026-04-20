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

// Unit tests for keychain token storage

import { afterAll, beforeAll, expect, it } from 'bun:test';

import {
  deleteToken,
  getAllCredentials,
  getToken,
  purgeAllTokens,
  saveToken,
} from '../../../../../src/lib/keychain.js';
import { createKeychainTestHandle } from '../../../keychain/keychain-test-handle.js';

const handle = createKeychainTestHandle();
beforeAll(() => handle.setup());
afterAll(() => handle.teardown());

it('keychain: save and get token for SonarCloud with org', async () => {
  await saveToken('https://sonarcloud.io', 'squ_abc123', 'my-org');
  expect(await getToken('https://sonarcloud.io', 'my-org')).toBe('squ_abc123');
  await purgeAllTokens();
});

it('keychain: get non-existent token returns null', async () => {
  expect(await getToken('https://nonexistent.io', 'no-org')).toBe(null);
});

it('keychain: getAllCredentials returns empty array when no tokens', async () => {
  expect(await getAllCredentials()).toHaveLength(0);
});

it('keychain: purgeAllTokens removes all tokens', async () => {
  await saveToken('https://sonarcloud.io', 'token1', 'org1');
  await saveToken('https://sonarqube.io', 'token2');
  expect(await getAllCredentials()).toHaveLength(2);

  await purgeAllTokens();

  expect(await getAllCredentials()).toHaveLength(0);
});

it('keychain: normalize server URLs with trailing slashes', async () => {
  await saveToken('https://sonarqube.io/', 'test-token');
  expect(await getToken('https://sonarqube.io')).toBe('test-token');
  await purgeAllTokens();
});

it('keychain: handle special characters in org names', async () => {
  await saveToken('https://sonarcloud.io', 'token-special', 'my-org_with.special-chars');
  expect(await getToken('https://sonarcloud.io', 'my-org_with.special-chars')).toBe(
    'token-special',
  );
  await purgeAllTokens();
});

it('keychain: org parameter is optional for SonarQube (undefined treated as absent)', async () => {
  await saveToken('https://sonarqube.io', 'sq-token');
  expect(await getToken('https://sonarqube.io', undefined)).toBe('sq-token');
  await purgeAllTokens();
});

it('keychain: deleting one org token does not affect others', async () => {
  await saveToken('https://sonarcloud.io', 'token-org1', 'org1');
  await saveToken('https://sonarcloud.io', 'token-org2', 'org2');

  await deleteToken('https://sonarcloud.io', 'org1');

  expect(await getToken('https://sonarcloud.io', 'org1')).toBe(null);
  expect(await getToken('https://sonarcloud.io', 'org2')).toBe('token-org2');

  const remaining = await getAllCredentials();
  expect(remaining).toHaveLength(1);
  expect(remaining[0].account).toBe('sonarcloud.io:org2');

  await purgeAllTokens();
});

it('keychain: mixed SonarCloud orgs and SonarQube servers', async () => {
  await saveToken('https://sonarcloud.io', 'sc-token-org1', 'org1');
  await saveToken('https://sonarcloud.io', 'sc-token-org2', 'org2');
  await saveToken('https://sq1.io', 'sq-token-1');
  await saveToken('https://sq2.io', 'sq-token-2');

  const allCreds = await getAllCredentials();
  expect(allCreds).toHaveLength(4);

  expect(await getToken('https://sonarcloud.io', 'org1')).toBe('sc-token-org1');
  expect(await getToken('https://sonarcloud.io', 'org2')).toBe('sc-token-org2');
  expect(await getToken('https://sq1.io')).toBe('sq-token-1');
  expect(await getToken('https://sq2.io')).toBe('sq-token-2');

  await purgeAllTokens();
  expect(await getAllCredentials()).toHaveLength(0);
});
