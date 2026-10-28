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

// Unit tests for keychain token storage

import { afterEach, beforeEach, expect, it } from 'bun:test';

import { deleteToken, getToken, saveToken } from '@/core/host/keychain.ts';

import { createKeychainTestHandle } from '../../core/host/keychain-test-handle.ts';

const handle = createKeychainTestHandle();
beforeEach(() => handle.setup());
afterEach(() => handle.teardown());

it('keychain: save and get token for SonarCloud', async () => {
  await saveToken('https://sonarcloud.io', 'squ_abc123');
  expect(await getToken('https://sonarcloud.io')).toBe('squ_abc123');
});

it('keychain: get non-existent token returns null', async () => {
  expect(await getToken('https://nonexistent.io')).toBeNull();
});

it('keychain: normalize server URLs with trailing slashes', async () => {
  await saveToken('https://sonarqube.io/', 'test-token');
  expect(await getToken('https://sonarqube.io')).toBe('test-token');
});

it('keychain: deleting one server token does not affect others', async () => {
  await saveToken('https://sonarcloud.io', 'token-cloud');
  await saveToken('https://sonarqube.us', 'token-us');

  await deleteToken('https://sonarcloud.io');

  expect(await getToken('https://sonarcloud.io')).toBeNull();
  expect(await getToken('https://sonarqube.us')).toBe('token-us');
});

it('keychain: separate servers keep separate tokens', async () => {
  await saveToken('https://sonarcloud.io', 'sc-token');
  await saveToken('https://sq1.io', 'sq-token-1');
  await saveToken('https://sq2.io', 'sq-token-2');

  expect(await getToken('https://sonarcloud.io')).toBe('sc-token');
  expect(await getToken('https://sq1.io')).toBe('sq-token-1');
  expect(await getToken('https://sq2.io')).toBe('sq-token-2');
});
