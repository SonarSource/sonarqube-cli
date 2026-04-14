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

import { clearTokenCache, generateKeychainAccount, saveToken } from '../../../src/lib/keychain';

export interface KeychainTestHandle {
  /**
   * Seed a token into the real OS credential store and clear the cache
   * so the next read goes to the backend. Same signature as saveToken.
   */
  seedToken(serverUrl: string, token: string, org?: string): Promise<void>;
  setup(): void;
  teardown(): Promise<void>;
}

export function createKeychainTestHandle(): KeychainTestHandle {
  let serviceName = '';
  const trackedAccounts = new Set<string>();
  let savedKeychainFile: string | undefined;
  let savedDisableKeychain: string | undefined;
  let savedService: string | undefined;

  return {
    async seedToken(serverUrl: string, token: string, org?: string) {
      trackedAccounts.add(generateKeychainAccount(serverUrl, org));
      await saveToken(serverUrl, token, org);
      clearTokenCache();
    },

    setup() {
      serviceName = `sonarqube-cli-test-${crypto.randomUUID()}`;
      trackedAccounts.clear();

      savedKeychainFile = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
      savedDisableKeychain = process.env.SONARQUBE_CLI_DISABLE_KEYCHAIN;
      savedService = process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE;

      delete process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
      delete process.env.SONARQUBE_CLI_DISABLE_KEYCHAIN;
      process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE = serviceName;

      clearTokenCache();
    },

    async teardown() {
      for (const account of trackedAccounts) {
        await Bun.secrets.delete({ service: serviceName, name: account }).catch(() => {});
      }
      trackedAccounts.clear();

      if (savedKeychainFile === undefined) {
        delete process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
      } else {
        process.env.SONARQUBE_CLI_KEYCHAIN_FILE = savedKeychainFile;
      }

      if (savedDisableKeychain === undefined) {
        delete process.env.SONARQUBE_CLI_DISABLE_KEYCHAIN;
      } else {
        process.env.SONARQUBE_CLI_DISABLE_KEYCHAIN = savedDisableKeychain;
      }

      if (savedService === undefined) {
        delete process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE;
      } else {
        process.env.SONARQUBE_CLI_KEYCHAIN_SERVICE = savedService;
      }

      clearTokenCache();
    },
  };
}
