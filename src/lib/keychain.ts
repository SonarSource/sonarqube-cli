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

// Keychain operations wrapper for keytar

import { readFileSync, writeFileSync } from 'node:fs';
import { APP_NAME as SERVICE_NAME } from './config-constants.js';

interface Credential {
  account: string;
  password: string;
}

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Credential[]>;
}

let keytar: KeytarModule | null = null;
const tokenCache = new Map<string, string | null>();

const noOpKeytar: KeytarModule = {
  getPassword: () => Promise.resolve(null),
  setPassword: () => Promise.resolve(),
  deletePassword: () => Promise.resolve(false),
  findCredentials: () => Promise.resolve([]),
};

interface KeychainStore {
  tokens: Record<string, string>;
}

function createFileKeytar(filePath: string): KeytarModule {
  const readStore = (): KeychainStore => {
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as KeychainStore;
    } catch {
      return { tokens: {} };
    }
  };

  const writeStore = (store: KeychainStore): void => {
    writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
  };

  return {
    getPassword: (_service, account) => Promise.resolve(readStore().tokens[account] ?? null),
    setPassword: (_service, account, password) => {
      const store = readStore();
      store.tokens[account] = password;
      writeStore(store);
      return Promise.resolve();
    },
    deletePassword: (_service, account) => {
      const store = readStore();
      if (!(account in store.tokens)) {
        return Promise.resolve(false);
      }
      const { [account]: _removed, ...remaining } = store.tokens;
      store.tokens = remaining;
      writeStore(store);
      return Promise.resolve(true);
    },
    findCredentials: (_service) => {
      const store = readStore();
      return Promise.resolve(
        Object.entries(store.tokens).map(([account, password]) => ({ account, password })),
      );
    },
  };
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

async function getKeytar() {
  const keychainFile = process.env.SONAR_CLI_KEYCHAIN_FILE;
  if (keychainFile) {
    return createFileKeytar(keychainFile);
  }

  if (process.env.SONAR_CLI_DISABLE_KEYCHAIN === 'true') {
    return noOpKeytar;
  }
  try {
    keytar ??= (await import('keytar')).default;
    return keytar;
  } catch {
    return noOpKeytar;
  }
}

/**
 * Generate keychain account key
 * SonarCloud: "sonarcloud.io:org-key"
 * SonarQube: "hostname"
 */
function generateKeychainAccount(serverURL: string, org?: string): string {
  try {
    const url = new URL(serverURL);
    const hostname = url.hostname;

    // SonarQube Cloud with organization
    if (org) {
      return `${hostname}:${org}`;
    }
    // SonarQube or hostname without organization
    return hostname;
  } catch {
    return serverURL;
  }
}

/**
 * Get token from system keychain
 * For SonarQube Cloud: pass org parameter
 * For SonarQube: org parameter is ignored
 * Uses in-memory cache to avoid repeated keychain prompts
 */
export async function getToken(serverURL: string, org?: string): Promise<string | null> {
  const account = generateKeychainAccount(serverURL, org);

  // Check cache first (avoids multiple keychain prompts)
  if (tokenCache.has(account)) {
    return tokenCache.get(account) ?? null;
  }

  const kt = await getKeytar();
  const token = await kt.getPassword(SERVICE_NAME, account);

  // Cache the result (including null for "not found")
  tokenCache.set(account, token);
  return token;
}

/**
 * Save token to system keychain
 * For SonarQube Cloud: pass org parameter
 * For SonarQube: org parameter is ignored
 * Updates in-memory cache
 */
export async function saveToken(serverURL: string, token: string, org?: string): Promise<void> {
  const account = generateKeychainAccount(serverURL, org);
  const kt = await getKeytar();
  await kt.setPassword(SERVICE_NAME, account, token);
  // Update cache
  tokenCache.set(account, token);
}

/**
 * Delete token from system keychain
 * For SonarQube Cloud: pass org parameter
 * For SonarQube: org parameter is ignored
 * Removes from cache
 */
export async function deleteToken(serverURL: string, org?: string): Promise<void> {
  const account = generateKeychainAccount(serverURL, org);
  const kt = await getKeytar();
  await kt.deletePassword(SERVICE_NAME, account);
  // Remove from cache
  tokenCache.delete(account);
}

/**
 * Get all credentials for this service
 */
export async function getAllCredentials(): Promise<Array<{ account: string; password: string }>> {
  const kt = await getKeytar();
  return await kt.findCredentials(SERVICE_NAME);
}

/**
 * Clear all tokens for this service and cache
 */
export async function purgeAllTokens(): Promise<void> {
  const credentials = await getAllCredentials();
  const kt = await getKeytar();
  for (const cred of credentials) {
    await kt.deletePassword(SERVICE_NAME, cred.account);
  }
  // Clear cache
  tokenCache.clear();
}
