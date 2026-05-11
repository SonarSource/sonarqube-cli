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

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const normalizePath = (p: string): string => p.replaceAll('\\', '/');

/**
 * POSIX-style path of `file` relative to `base` (defaults to cwd).
 * Canonicalizes both legs so in-`base` symlinks resolving outside are rejected.
 * Returns null on traversal or absolute paths.
 */
export function toRelativePosixPath(file: string, base: string = process.cwd()): string | null {
  const canonicalFile = canonicalizePath(file);
  const canonicalBase = canonicalizePath(base);
  const rel = normalizePath(relative(canonicalBase, canonicalFile));
  if (isAbsolute(rel) || rel.split('/').includes('..')) return null;
  return rel;
}

/**
 * Returns the canonical, fully-resolved path for a directory.
 * On Windows, realpathSync resolves the filesystem-authoritative casing
 * (e.g. "c:\Users\..." → "C:\Users\..."), preventing duplicate keys when
 * the same directory is represented with different cases or separators.
 * Falls back to path.resolve() if the path doesn't exist yet.
 */
export function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
