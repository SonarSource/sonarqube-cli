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

// Keychain operations - OS-backed via Bun.secrets, with file fallback for tests

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ACCOUNT_INDEX_FILE, APP_NAME } from './config-constants.js';
import { CommandFailedError } from '../cli/commands/_common/error.js';

function getServiceName(): string {
  return process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE || APP_NAME;
}

interface KeychainBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

const tokenCache = new Map<string, string | null>();

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
};

interface KeychainStore {
  tokens: Record<string, string>;
}

function readFileStore(filePath: string): KeychainStore {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as KeychainStore;
  } catch {
    return { tokens: {} };
  }
}

function writeFileStore(filePath: string, store: KeychainStore): void {
  writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

function createFileBackend(filePath: string): KeychainBackend {
  return {
    getPassword: (_service, account) =>
      Promise.resolve(readFileStore(filePath).tokens[account] ?? null),
    setPassword: (_service, account, password) => {
      const store = readFileStore(filePath);
      store.tokens[account] = password;
      writeFileStore(filePath, store);
      return Promise.resolve();
    },
    deletePassword: (_service, account) => {
      const store = readFileStore(filePath);
      if (!(account in store.tokens)) {
        return Promise.resolve(false);
      }
      const { [account]: _removed, ...remaining } = store.tokens;
      store.tokens = remaining;
      writeFileStore(filePath, store);
      return Promise.resolve(true);
    },
  };
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

function getAccountIndexPath(): string {
  return process.env.SONARQUBE_CLI_ACCOUNT_INDEX_FILE || ACCOUNT_INDEX_FILE;
}

function readAccountIndex(): string[] {
  try {
    const data = JSON.parse(readFileSync(getAccountIndexPath(), 'utf-8')) as {
      accounts?: unknown;
    };
    return Array.isArray(data.accounts) ? (data.accounts as string[]) : [];
  } catch {
    return [];
  }
}

function writeAccountIndex(accounts: string[]): void {
  const filePath = getAccountIndexPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ accounts }, null, 2), 'utf-8');
}

function addToAccountIndex(account: string): void {
  const accounts = readAccountIndex();
  if (!accounts.includes(account)) {
    accounts.push(account);
    writeAccountIndex(accounts);
  }
}

function removeFromAccountIndex(account: string): void {
  const accounts = readAccountIndex();
  const filtered = accounts.filter((a) => a !== account);
  if (filtered.length !== accounts.length) {
    writeAccountIndex(filtered);
  }
}

function isFileBackend(): boolean {
  return Boolean(process.env.SONARQUBE_CLI_KEYCHAIN_FILE);
}

function getBackend(): KeychainBackend {
  const keychainFile = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
  if (keychainFile) {
    return createFileBackend(keychainFile);
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
  tokenCache.set(account, token);
  if (!isFileBackend()) {
    addToAccountIndex(account);
  }
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
  tokenCache.delete(account);
  if (!isFileBackend()) {
    removeFromAccountIndex(account);
  }
}

export async function getAllCredentials(): Promise<Array<{ account: string; password: string }>> {
  const keychainFile = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
  if (keychainFile) {
    const store = readFileStore(keychainFile);
    return Object.entries(store.tokens).map(([account, password]) => ({ account, password }));
  }

  const accounts = readAccountIndex();
  const service = getServiceName();
  const results: Array<{ account: string; password: string }> = [];
  for (const account of accounts) {
    const password = await bunSecretsBackend.getPassword(service, account);
    if (password != null) {
      results.push({ account, password });
    }
  }
  return results;
}

/**
 * Clear all tokens for this service and cache
 */
export async function purgeAllTokens(): Promise<void> {
  const credentials = await getAllCredentials();
  const backend = getBackend();
  const service = getServiceName();
  for (const cred of credentials) {
    await backend.deletePassword(service, cred.account);
  }
  if (!isFileBackend()) {
    writeAccountIndex([]);
  }
  tokenCache.clear();
}
