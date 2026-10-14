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

const KEYCHAIN_FAILURE_MESSAGE = 'Failed to access the system keychain.';
const MISSING_KEYCHAIN_MESSAGE =
  'No usable system keychain is available: libsecret could not be loaded.';
const KEYCHAIN_REPAIR_HINT =
  "Make sure your system's keychain or credential manager is available and unlocked, then try again.";
const MISSING_KEYCHAIN_HINT =
  'Install or repair libsecret, or authenticate via environment variables: SONARQUBE_CLI_TOKEN ' +
  'plus either SONARQUBE_CLI_SERVER (SonarQube Server) or SONARQUBE_CLI_ORG (SonarQube Cloud).';

export class MissingKeychainError extends CommandFailedError {
  constructor(detail: string) {
    super(`${MISSING_KEYCHAIN_MESSAGE}\n\nUnderlying error: ${detail}`, {
      remediationHint: MISSING_KEYCHAIN_HINT,
    });
    this.name = 'MissingKeychainError';
  }
}

async function wrapBunSecrets<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (process.platform === 'linux' && detail === 'libsecret not available') {
      throw new MissingKeychainError(detail);
    }
    throw new CommandFailedError(`${KEYCHAIN_FAILURE_MESSAGE}\n\nUnderlying error: ${detail}`, {
      remediationHint: KEYCHAIN_REPAIR_HINT,
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
 * SonarQube Cloud: "https://sonarcloud.io:org-key"
 * SonarQube Server: "https://hostname/base-path"
 */
export function generateKeychainAccount(serverURL: string, org?: string): string {
  try {
    const url = new URL(serverURL);
    let pathEnd = url.pathname.length;
    while (pathEnd > 0 && url.pathname[pathEnd - 1] === '/') {
      pathEnd--;
    }
    const server = url.origin + url.pathname.slice(0, pathEnd);

    // SonarQube Cloud with organization
    if (org) {
      return `${server}:${org}`;
    }
    return server;
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

async function removeSecret(account: string): Promise<boolean> {
  const removed = await getBackend().deletePassword(getServiceName(), account);
  secretCache.delete(account);
  return removed;
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
): Promise<string[]> {
  const newAccount = generateKeychainAccount(newServerURL, newOrg);
  for (const conn of connections) {
    const account = generateKeychainAccount(conn.serverUrl, conn.orgKey);
    if (account !== newAccount) {
      await removeSecret(account);
    }
  }
  return connections.reduce(
    async (previous, conn) => {
      const removedServerUrls = await previous;
      if (await deleteLegacyTokens(conn.serverUrl, conn.orgKey)) {
        removedServerUrls.push(conn.serverUrl);
      }
      return removedServerUrls;
    },
    Promise.resolve([] as string[]),
  );
}

export async function deleteLegacyTokens(serverURL: string, org?: string): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(serverURL).hostname;
  } catch {
    return false;
  }

  const removedHostToken = await removeSecret(hostname);
  const removedOrgToken = org ? await removeSecret(`${hostname}:${org}`) : false;
  return removedHostToken || removedOrgToken;
}

/**
 * Delete token from system keychain
 * For SonarQube Cloud: pass org parameter
 * For SonarQube Server: org parameter is ignored
 * Removes from cache
 */
export async function deleteToken(serverURL: string, org?: string): Promise<void> {
  await removeSecret(generateKeychainAccount(serverURL, org));
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

export function deleteConfigSecret(key: string): Promise<boolean> {
  return removeSecret(generateConfigKeychainAccount(key));
}
