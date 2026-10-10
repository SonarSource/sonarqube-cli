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

import { constants as fsConstants, lstat, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';

const REFUSING_SYMLINK_MESSAGE = 'Refusing to modify a path that uses a symbolic link.';
const REFUSING_SYMLINK_HINT =
  'Remove the symlink from the integration target path and re-run the integration command.';

/** Walks up from `filePath` and rejects when any existing path component is a symlink. */
export async function assertSafeWritePath(filePath: string): Promise<void> {
  let current = resolve(filePath);
  const visited = new Set<string>();

  while (!visited.has(current)) {
    visited.add(current);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new CommandFailedError(REFUSING_SYMLINK_MESSAGE, {
          remediationHint: REFUSING_SYMLINK_HINT,
        });
      }
      return;
    } catch (error) {
      if (error instanceof CommandFailedError) {
        throw error;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

export async function writeRegularFile(
  path: string,
  content: string,
  mode?: number,
): Promise<void> {
  await assertSafeWritePath(path);
  const parent = dirname(path);
  if (parent !== path) {
    await mkdir(parent, { recursive: true });
  }
  const flags =
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
  const fileHandle = await open(path, flags, mode);
  try {
    await fileHandle.writeFile(content, 'utf-8');
  } finally {
    await fileHandle.close();
  }
}
