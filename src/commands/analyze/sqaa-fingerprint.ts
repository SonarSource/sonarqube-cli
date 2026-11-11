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

import { readSqaaFileContent } from './sqaa-api.ts';
import { type ChangeSetOptions, resolveChangeSet } from './sqaa-changeset.ts';
import { toRelativePosixPath } from './sqaa-paths.ts';

export async function fingerprintGitChangeSet(
  cwd: string,
  options: ChangeSetOptions = {},
): Promise<string> {
  const { files, repoRoot } = await resolveChangeSet(cwd, options);
  const entries = files
    .map((file): [string, string] => [
      toRelativePosixPath(file, repoRoot),
      readSqaaFileContent(file),
    ])
    .sort(([a], [b]) => {
      if (a < b) return -1;
      return a > b ? 1 : 0;
    });
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
