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
 * Stable anonymous user identifier stored in ~/.sonar/user.
 *
 * The file is created atomically on first use (O_CREAT | O_EXCL) so that
 * concurrent processes always converge on the same UUID. Existing
 * ~/.sonar/sonarqube-cli/user files are promoted on first use and then removed.
 */

import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getCliDir, getSonarUserHome } from '../lib/config-constants.js';

function getSharedUserFile(): string {
  return join(getSonarUserHome(), 'user');
}

function getLegacyUserFile(): string {
  return join(getCliDir(), 'user');
}

function tryReadUserId(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

function createUserIdIfMissing(filePath: string, dirPath: string, id: string): string {
  mkdirSync(dirPath, { recursive: true });

  try {
    const fd = openSync(filePath, 'wx');
    try {
      writeFileSync(fd, id, 'utf-8');
    } finally {
      closeSync(fd);
    }
    return id;
  } catch {
    return readFileSync(filePath, 'utf-8').trim();
  }
}

function removeLegacyUserFile(): void {
  try {
    unlinkSync(getLegacyUserFile());
  } catch {
    // Best effort cleanup only.
  }
}

/**
 * Return the persisted user ID, creating it atomically if it does not exist yet.
 */
export function getOrCreateUserId(): string {
  const sharedUserFile = getSharedUserFile();
  const sharedUserId = tryReadUserId(sharedUserFile);
  if (sharedUserId !== undefined) {
    removeLegacyUserFile();
    return sharedUserId;
  }

  const legacyUserFile = getLegacyUserFile();
  const legacyUserId = tryReadUserId(legacyUserFile);
  if (legacyUserId !== undefined) {
    const userId = createUserIdIfMissing(sharedUserFile, getSonarUserHome(), legacyUserId);
    removeLegacyUserFile();
    return userId;
  }

  return createUserIdIfMissing(sharedUserFile, getSonarUserHome(), randomUUID());
}
