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

import { CommandFailedError } from '@/core/commands/command-error.ts';

import { APP_NAME } from '../config-constants.ts';

function getServiceName(): string {
  return process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE || APP_NAME;
}

interface KeychainBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

const secretCache = new Map<string, string | null>();

const KEYCHAIN_UNAVAILABLE_MESSAGE = 'Failed to access the system keychain.';
const KEYCHAIN_UNAVAILABLE_HINT =
  "Make sure your system's keychain or credential manager is available and unlocked, then try again. " +
  'Alternatively, authenticate via environment variables instead of the keychain: SONARQUBE_CLI_TOKEN ' +
  'plus either SONARQUBE_CLI_SERVER (SonarQube Server) or SONARQUBE_CLI_ORG (SonarQube Cloud).';

async function wrapBunSecrets<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CommandFailedError(`${KEYCHAIN_UNAVAILABLE_MESSAGE}\n\nUnderlying error: ${detail}`, {
      remediationHint: KEYCHAIN_UNAVAILABLE_HINT,
    });
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

export function clearSecretCache(): void {
  secretCache.clear();
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

async function readSecret(account: string): Promise<string | null> {
  // Check cache first (avoids multiple keychain prompts)
  if (secretCache.has(account)) {
    return secretCache.get(account) ?? null;
  }

  const secret = await getBackend().getPassword(getServiceName(), account);

  // Cache the result (including null for "not found")
  secretCache.set(account, secret);
  return secret;
}

async function writeSecret(account: string, value: string): Promise<void> {
  await getBackend().setPassword(getServiceName(), account, value);
  secretCache.set(account, value);
}

async function removeSecret(account: string): Promise<void> {
  await getBackend().deletePassword(getServiceName(), account);
  secretCache.delete(account);
}

/**
 * Get token from system keychain
 * For SonarQube Cloud: pass org parameter
 * For SonarQube Server: org parameter is ignored
 * Uses in-memory cache to avoid repeated keychain prompts
 */
export function getToken(serverURL: string, org?: string): Promise<string | null> {
  return readSecret(generateKeychainAccount(serverURL, org));
}

/**
 * Save token to system keychain
 * For SonarQube Cloud: pass org parameter
 * For SonarQube Server: org parameter is ignored
 * Updates in-memory cache
 */
export function saveToken(serverURL: string, token: string, org?: string): Promise<void> {
  return writeSecret(generateKeychainAccount(serverURL, org), token);
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
  const staleAccounts = connections
    .map((conn) => generateKeychainAccount(conn.serverUrl, conn.orgKey))
    .filter((account) => account !== newAccount);
  await Promise.all(staleAccounts.map((account) => removeSecret(account)));
}

/**
 * Delete token from system keychain
 * For SonarQube Cloud: pass org parameter
 * For SonarQube Server: org parameter is ignored
 * Removes from cache
 */
export function deleteToken(serverURL: string, org?: string): Promise<void> {
  return removeSecret(generateKeychainAccount(serverURL, org));
}

function generateConfigKeychainAccount(key: string): string {
  return `config/${key}`;
}

export function getConfigSecret(key: string): Promise<string | null> {
  return readSecret(generateConfigKeychainAccount(key));
}

export function saveConfigSecret(key: string, value: string): Promise<void> {
  return writeSecret(generateConfigKeychainAccount(key), value);
}

export function deleteConfigSecret(key: string): Promise<void> {
  return removeSecret(generateConfigKeychainAccount(key));
}
