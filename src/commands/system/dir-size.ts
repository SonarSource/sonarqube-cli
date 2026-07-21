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

import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function directorySizeBytes(dir: string): number {
  if (!existsSync(dir)) {
    return 0;
  }

  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      total += entrySizeBytes(join(dir, entry.name), entry);
    }
  } catch {
    // Directory vanished or is unreadable; size is cosmetic only.
  }
  return total;
}

function entrySizeBytes(path: string, entry: Dirent): number {
  try {
    if (entry.isDirectory()) {
      return directorySizeBytes(path);
    }
    if (entry.isFile()) {
      return statSync(path).size;
    }
  } catch {
    // Entry vanished or is inaccessible; ignore for size estimation.
  }
  return 0;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
