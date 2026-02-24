/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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
 * Stable anonymous user identifier stored in ~/.sonarqube-cli/user.
 *
 * The file is created atomically on first use (O_CREAT | O_EXCL) so that
 * concurrent processes always converge on the same UUID.
 */

import { openSync, closeSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CLI_DIR } from '../lib/config-constants.js';

const USER_FILE = join(CLI_DIR, 'user');

/**
 * Return the persisted user ID, creating it atomically if it does not exist yet.
 */
export function getOrCreateUserId(): string {
  // Fast path — file already exists.
  try {
    return readFileSync(USER_FILE, 'utf-8').trim();
  } catch {
    // Fall through to create.
  }

  mkdirSync(CLI_DIR, { recursive: true });

  const id = randomUUID();
  try {
    const fd = openSync(USER_FILE, 'wx');
    try {
      writeFileSync(fd, id, 'utf-8');
    } finally {
      closeSync(fd);
    }
    return id;
  } catch {
    // Another process won the race — read the ID they wrote.
    return readFileSync(USER_FILE, 'utf-8').trim();
  }
}
