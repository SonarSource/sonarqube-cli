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

import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

import { getCliDir } from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';

const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;

export function claimSessionWarning(agent: string, sessionId: string | undefined): boolean {
  if (!sessionId) return true;
  const key = createHash('sha256')
    .update(JSON.stringify([agent, sessionId]))
    .digest('hex');
  try {
    const directory = join(getCliDir(), 'session-warnings');
    mkdirSync(directory, { recursive: true, mode: OWNER_DIRECTORY_MODE });
    // Exclusive creation deduplicates warnings across concurrent hook processes.
    closeSync(openSync(join(directory, key), 'wx', OWNER_FILE_MODE));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    logger.debug('Could not persist the session warning marker');
    return true;
  }
}
