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

import { readFileSync, writeFileSync } from 'node:fs';
import { APP_NAME } from './config-constants.js';
import { CommandFailedError } from '../cli/commands/_common/error.js';
import { loadState } from './state-manager.js';

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
  "Failed to access the system keychain. Please make sure your system's keychain or credential manager is available and unlocked and try again.";

async function wrapBunSecrets<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CommandFailedError(`${KEYCHAIN_UNAVAILABLE_MESSAGE}\n\nUnderlying error: ${detail}`);
  }
}

const bunSecretsBackend: KeychainBackend = {
  getPassword: (service, account) =>
    wrapBunSecrets(() => Bun.secrets.get({ service, name: account })),
  setPassword: (service, account, password) =>
    wrapBunSecrets(() => Bun.secrets.set({ service, name: account, value: password })),
  deletePassword: (service, account) =>
    wrapBunSecrets(() => Bun.secrets.delete({ service, name: account })),
};

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

interface KeychainStore {
  tokens: Record<string, string>;
}

function writeFileStore(filePath: string, store: KeychainStore): void {
  writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

function readFileStore(filePath: string): KeychainStore {
  return readJsonFile(filePath, { tokens: {} });
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

let cachedFileBackend: { path: string; backend: KeychainBackend } | null = null;

/** Returns the file-backend path if set (tests/CI only), undefined otherwise. */
function getKeychainFilePath(): string | undefined {
  return process.env.SONARQUBE_CLI_KEYCHAIN_FILE || undefined;
}

function getBackend(): KeychainBackend {
  const filePath = getKeychainFilePath();
  if (filePath) {
    if (cachedFileBackend?.path !== filePath) {
      cachedFileBackend = { path: filePath, backend: createFileBackend(filePath) };
    }
    return cachedFileBackend.backend;
  }

  cachedFileBackend = null;
  return bunSecretsBackend;
}

/**
 * Derive account names from the connections stored in state.json.
 */
function deriveAccountsFromConnections(): string[] {
  const state = loadState();
  return state.auth.connections.map((c) => generateKeychainAccount(c.serverUrl, c.orgKey));
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
}

/**
 * Delete tokens for connections that are about to be replaced.
 * Skips the new connection's account (identified by newServerURL + newOrg) so
 * it doesn't get deleted right before being written.
 */
export async function deleteStaleTokens(
  connections: ReadonlyArray<{ serverUrl: string; orgKey?: string }>,
  newServerURL: string,
  newOrg?: string,
): Promise<void> {
  const newAccount = generateKeychainAccount(newServerURL, newOrg);
  const backend = getBackend();
  const service = getServiceName();
  for (const conn of connections) {
    const account = generateKeychainAccount(conn.serverUrl, conn.orgKey);
    if (account !== newAccount) {
      await backend.deletePassword(service, account);
      tokenCache.delete(account);
    }
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
}

export async function getAllCredentials(): Promise<Array<{ account: string; password: string }>> {
  const filePath = getKeychainFilePath();
  if (filePath) {
    const store = readFileStore(filePath);
    return Object.entries(store.tokens).map(([account, password]) => ({ account, password }));
  }

  const accounts = deriveAccountsFromConnections();
  const backend = getBackend();
  const service = getServiceName();
  const results: Array<{ account: string; password: string }> = [];
  for (const account of accounts) {
    const password = await backend.getPassword(service, account);
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
  tokenCache.clear();
}
