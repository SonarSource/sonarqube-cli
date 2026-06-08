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

import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { ENV_SONAR_USER_HOME } from '../../../src/lib/config-constants.js';
import { getOrCreateUserId } from '../../../src/telemetry/user.js';

describe('getOrCreateUserId', () => {
  const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];

  let testSonarUserHome: string;

  beforeEach(() => {
    testSonarUserHome = mkdtempSync(join(tmpdir(), 'sonar-user-test-'));
    process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;
  });

  afterEach(() => {
    rmSync(testSonarUserHome, { recursive: true, force: true });

    if (previousSonarUserHome === undefined) {
      delete process.env[ENV_SONAR_USER_HOME];
    } else {
      process.env[ENV_SONAR_USER_HOME] = previousSonarUserHome;
    }
  });

  function sharedUserFile(): string {
    return join(testSonarUserHome, 'user');
  }

  function legacyUserFile(): string {
    return join(testSonarUserHome, 'sonarqube-cli', 'user');
  }

  function writeUserFile(filePath: string, userId: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, userId, 'utf-8');
  }

  it('returns the shared user id when it already exists', () => {
    writeUserFile(sharedUserFile(), 'shared-user-id');

    expect(getOrCreateUserId()).toBe('shared-user-id');
  });

  it('removes a matching legacy file when the shared user id exists', () => {
    writeUserFile(sharedUserFile(), 'shared-user-id');
    writeUserFile(legacyUserFile(), 'shared-user-id');

    expect(getOrCreateUserId()).toBe('shared-user-id');
    expect(fs.existsSync(legacyUserFile())).toBe(false);
  });

  it('removes a differing legacy file when the shared user id exists', () => {
    writeUserFile(sharedUserFile(), 'shared-user-id');
    writeUserFile(legacyUserFile(), 'legacy-user-id');

    expect(getOrCreateUserId()).toBe('shared-user-id');
    expect(fs.existsSync(legacyUserFile())).toBe(false);
  });

  it('migrates the legacy user id into the shared root', () => {
    writeUserFile(legacyUserFile(), 'legacy-user-id');

    expect(getOrCreateUserId()).toBe('legacy-user-id');
    expect(readFileSync(sharedUserFile(), 'utf-8')).toBe('legacy-user-id');
    expect(fs.existsSync(legacyUserFile())).toBe(false);
  });

  it('creates a new shared user id when no file exists yet', () => {
    const userId = getOrCreateUserId();

    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(sharedUserFile(), 'utf-8')).toBe(userId);
  });

  it('falls back to the user id created by another process during the atomic create race', () => {
    const sharedFile = sharedUserFile();
    const originalOpenSync = fs.openSync;
    const originalWriteFileSync = fs.writeFileSync;
    const openSyncSpy = spyOn(fs, 'openSync').mockImplementation(
      (...args: Parameters<typeof fs.openSync>) => {
        const [filePath, flags] = args;
        if (filePath === sharedFile && flags === 'wx') {
          originalWriteFileSync(sharedFile, 'race-winner-id', 'utf-8');
          throw new Error('EEXIST');
        }
        return originalOpenSync(...args);
      },
    );

    try {
      expect(getOrCreateUserId()).toBe('race-winner-id');
      expect(readFileSync(sharedFile, 'utf-8')).toBe('race-winner-id');
    } finally {
      openSyncSpy.mockRestore();
      unlinkSync(sharedFile);
    }
  });
});
