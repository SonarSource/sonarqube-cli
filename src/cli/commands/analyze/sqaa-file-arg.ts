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

// Parse repeatable `--file <path>` arguments for SQAA.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { InvalidOptionError } from '../_common/error.js';

export interface ResolvedSqaaFileEntry {
  absolutePath: string;
}

/** Commander collector for repeatable `--file` options. */
export function collectSqaaFileOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function resolveSqaaFileArgs(
  rawArgs: string[],
  cwd: string = process.cwd(),
): ResolvedSqaaFileEntry[] {
  const seenAbsolute = new Set<string>();
  const entries: ResolvedSqaaFileEntry[] = [];

  for (const path of rawArgs) {
    const absolutePath = resolve(cwd, path);
    if (seenAbsolute.has(absolutePath)) {
      throw new InvalidOptionError(`Duplicate --file entry: ${path}`);
    }
    seenAbsolute.add(absolutePath);
    if (!existsSync(absolutePath)) {
      throw new InvalidOptionError(`File not found: ${path}`);
    }
    entries.push({ absolutePath });
  }

  return entries;
}
