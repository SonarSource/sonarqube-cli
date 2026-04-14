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

// Keychain operations - OS-backed via Bun.secrets, with file and no-op fallbacks

import { readFileSync, writeFileSync } from 'node:fs';
import { APP_NAME } from './config-constants.js';
import { CommandFailedError } from '../cli/commands/_common/error.js';

function getServiceName(): string {
  return process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE || APP_NAME;
}

interface Credential {
  account: string;
  password: string;
}

interface KeychainBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Credential[]>;
}

const tokenCache = new Map<string, string | null>();

const noOpBackend: KeychainBackend = {
  getPassword: () => Promise.resolve(null),
  setPassword: () => Promise.resolve(),
  deletePassword: () => Promise.resolve(false),
  findCredentials: () => Promise.resolve([]),
};

const KEYCHAIN_UNAVAILABLE_MESSAGE =
  'Could not access the system credential store. Please make sure your OS credential manager is available and unlocked.';

function wrapBunSecrets<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch((err: unknown) => {
    throw new CommandFailedError(
      `${KEYCHAIN_UNAVAILABLE_MESSAGE}\n\nUnderlying error: ${(err as Error).message}`,
    );
  });
}

const bunSecretsBackend: KeychainBackend = {
  getPassword: (service, account) =>
    wrapBunSecrets(() => Bun.secrets.get({ service, name: account })),
  setPassword: (service, account, password) =>
    wrapBunSecrets(() => Bun.secrets.set({ service, name: account, value: password })),
  deletePassword: (service, account) =>
    wrapBunSecrets(() => Bun.secrets.delete({ service, name: account })),
  // Bun.secrets has no list/enumerate API - CLI-270 will add an account index
  findCredentials: () => Promise.resolve([]),
};

interface KeychainStore {
  tokens: Record<string, string>;
}

function createFileBackend(filePath: string): KeychainBackend {
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

function getBackend(): KeychainBackend {
  const keychainFile = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
  if (keychainFile) {
    return createFileBackend(keychainFile);
  }

  if (process.env.SONARQUBE_CLI_DISABLE_KEYCHAIN === 'true') {
    return noOpBackend;
  }

  return bunSecretsBackend;
}

/**
 * Generate keychain account key
 * SonarQube Cloud: "sonarcloud.io:org-key"
 * SonarQube Server: "hostname"
 */
export function generateKeychainAccount(serverURL: string, org?: string): string {
  try {
    const url = new URL(serverURL);
    const hostname = url.hostname;

    // SonarQube Cloud with organization
    if (org) {
      return `${hostname}:${org}`;
    }
    // SonarQube Server or hostname without organization
    return hostname;
  } catch {
    return serverURL;
  }
}

/**
 * Get token from system keychain
 * For SonarQube Cloud: pass org parameter
 * For SonarQube Server: org parameter is ignored
 * Uses in-memory cache to avoid repeated keychain prompts
 */
export async function getToken(serverURL: string, org?: string): Promise<string | null> {
  const account = generateKeychainAccount(serverURL, org);

  // Check cache first (avoids multiple keychain prompts)
  if (tokenCache.has(account)) {
    return tokenCache.get(account) ?? null;
  }

  const backend = getBackend();
  const token = await backend.getPassword(getServiceName(), account);

  // Cache the result (including null for "not found")
  tokenCache.set(account, token);
  return token;
}

/**
 * Save token to system keychain
 * For SonarQube Cloud: pass org parameter
 * For SonarQube Server: org parameter is ignored
 * Updates in-memory cache
 */
export async function saveToken(serverURL: string, token: string, org?: string): Promise<void> {
  const account = generateKeychainAccount(serverURL, org);
  const backend = getBackend();
  await backend.setPassword(getServiceName(), account, token);
  // Update cache
  tokenCache.set(account, token);
}

/**
 * Delete token from system keychain
 * For SonarQube Cloud: pass org parameter
 * For SonarQube Server: org parameter is ignored
 * Removes from cache
 */
export async function deleteToken(serverURL: string, org?: string): Promise<void> {
  const account = generateKeychainAccount(serverURL, org);
  const backend = getBackend();
  await backend.deletePassword(getServiceName(), account);
  // Remove from cache
  tokenCache.delete(account);
}

export async function getAllCredentials(): Promise<Array<{ account: string; password: string }>> {
  const backend = getBackend();
  return await backend.findCredentials(getServiceName());
}

/**
 * Clear all tokens for this service and cache
 */
export async function purgeAllTokens(): Promise<void> {
  const credentials = await getAllCredentials();
  const backend = getBackend();
  for (const cred of credentials) {
    await backend.deletePassword(getServiceName(), cred.account);
  }
  tokenCache.clear();
}
