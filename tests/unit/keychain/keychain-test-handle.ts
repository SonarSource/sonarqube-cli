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
 * Test helper that uses the file-based keychain backend
 * (SONARQUBE_CLI_KEYCHAIN_FILE) to avoid touching the real OS credential store.
 *
 * Call setup() in beforeEach and teardown() in afterEach.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearTokenCache, saveToken as realSaveToken } from '../../../src/lib/keychain';

export interface KeychainTestHandle {
  /**
   * Seed a token into the file-based keychain and clear the cache
   * so the next read goes to the backend.
   */
  seedToken(serverUrl: string, token: string, org?: string): Promise<void>;
  /**
   * Save a token via the keychain module (cache is updated).
   */
  saveToken(serverUrl: string, token: string, org?: string): Promise<void>;
  setup(): void;
  teardown(): void;
}

export function createKeychainTestHandle(): KeychainTestHandle {
  let testDir = '';
  let savedKeychainFile: string | undefined;

  return {
    async seedToken(serverUrl: string, token: string, org?: string) {
      await realSaveToken(serverUrl, token, org);
      clearTokenCache();
    },

    async saveToken(serverUrl: string, token: string, org?: string) {
      await realSaveToken(serverUrl, token, org);
    },

    setup() {
      testDir = join(tmpdir(), `keychain-test-${crypto.randomUUID()}`);
      mkdirSync(testDir, { recursive: true });

      savedKeychainFile = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
      process.env.SONARQUBE_CLI_KEYCHAIN_FILE = join(testDir, 'keychain.json');

      clearTokenCache();
    },

    teardown() {
      rmSync(testDir, { recursive: true, force: true });

      if (savedKeychainFile === undefined) {
        delete process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
      } else {
        process.env.SONARQUBE_CLI_KEYCHAIN_FILE = savedKeychainFile;
      }

      clearTokenCache();
    },
  };
}
