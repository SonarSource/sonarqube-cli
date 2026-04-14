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

/**
 * Test helper that exercises the real Bun.secrets keychain backend with
 * a unique service name per test to ensure complete isolation.
 *
 * Each setup() generates a fresh SONARQUBE_CLI_KEYCHAIN_SERVICE value,
 * so tokens written by one test are invisible to the next. Teardown
 * deletes all tracked accounts from the OS credential store.
 *
 * For tests that need to manipulate the backing store independently
 * of the cache (e.g. corrupt a file), use SONARQUBE_CLI_KEYCHAIN_FILE
 * directly - see keychain.test.ts.
 *
 * Call setup() in beforeEach and teardown() in afterEach.
 */

import {
  clearTokenCache,
  generateKeychainAccount,
  saveToken as realSaveToken,
} from '../../../src/lib/keychain';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface KeychainTestHandle {
  /**
   * Seed a token into the real OS credential store and clear the cache
   * so the next read goes to the backend. Same signature as saveToken.
   */
  seedToken(serverUrl: string, token: string, org?: string): Promise<void>;
  /**
   * Save a token and track the account for cleanup. Use this instead of
   * importing saveToken directly in tests that use the Bun.secrets backend.
   */
  saveToken(serverUrl: string, token: string, org?: string): Promise<void>;
  setup(): void;
  teardown(): Promise<void>;
}

export function createKeychainTestHandle(): KeychainTestHandle {
  let serviceName = '';
  let testDir = '';
  const trackedAccounts = new Set<string>();
  let savedKeychainFile: string | undefined;
  let savedService: string | undefined;
  let savedAccountIndex: string | undefined;

  return {
    async seedToken(serverUrl: string, token: string, org?: string) {
      trackedAccounts.add(generateKeychainAccount(serverUrl, org));
      await realSaveToken(serverUrl, token, org);
      clearTokenCache();
    },

    async saveToken(serverUrl: string, token: string, org?: string) {
      trackedAccounts.add(generateKeychainAccount(serverUrl, org));
      await realSaveToken(serverUrl, token, org);
    },

    setup() {
      serviceName = `sonarqube-cli-test-${crypto.randomUUID()}`;
      testDir = join(tmpdir(), `keychain-idx-${crypto.randomUUID()}`);
      mkdirSync(testDir, { recursive: true });
      trackedAccounts.clear();

      savedKeychainFile = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
      savedService = process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE;
      savedAccountIndex = process.env.SONARQUBE_CLI_ACCOUNT_INDEX_FILE;

      delete process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
      process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE = serviceName;
      process.env.SONARQUBE_CLI_ACCOUNT_INDEX_FILE = join(testDir, 'keychain-accounts.json');

      clearTokenCache();
    },

    async teardown() {
      for (const account of trackedAccounts) {
        await Bun.secrets.delete({ service: serviceName, name: account }).catch(() => {});
      }
      trackedAccounts.clear();

      rmSync(testDir, { recursive: true, force: true });

      if (savedKeychainFile === undefined) {
        delete process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
      } else {
        process.env.SONARQUBE_CLI_KEYCHAIN_FILE = savedKeychainFile;
      }

      if (savedService === undefined) {
        delete process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE;
      } else {
        process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE = savedService;
      }

      if (savedAccountIndex === undefined) {
        delete process.env.SONARQUBE_CLI_ACCOUNT_INDEX_FILE;
      } else {
        process.env.SONARQUBE_CLI_ACCOUNT_INDEX_FILE = savedAccountIndex;
      }

      clearTokenCache();
    },
  };
}
