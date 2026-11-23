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

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { getCliDir } from '@/core/config-constants.ts';

export async function withAgentInstallLock<T>(
  install: () => Promise<T> | T,
  unavailableMessage = 'Could not start agent setup. Retry setup shortly.',
): Promise<T> {
  const dir = getCliDir();
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'agent-install.lock.sqlite'), { create: true });
  try {
    try {
      db.run('PRAGMA busy_timeout = 500');
      db.run('BEGIN IMMEDIATE');
    } catch (error) {
      throw new CommandFailedError(unavailableMessage, {
        cause: error,
      });
    }
    return await install();
  } finally {
    db.close();
  }
}
