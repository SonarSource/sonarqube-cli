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

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import logger from '@/core/observability/logger.ts';

/**
 * Resolve symlinks on the deepest existing prefix, then re-append any missing
 * trailing segments so non-existent paths under a symlinked root compare correctly.
 *
 * Example: the allowed root is a symlink, and the binary was already deleted.
 *
 *   BIN_DIR     → /Users/me/.sonar/bin          (symlink)
 *   real BIN    → /private/var/.../sonar/bin    (realpathSync of the link)
 *   stale entry → /Users/me/.sonar/bin/sonar-secrets   (file no longer on disk)
 */
function resolvePathPreservingSuffix(absolutePath: string): string {
  const normalized = resolve(absolutePath);
  if (existsSync(normalized)) {
    return realpathSync(normalized);
  }

  const trailingSegments: string[] = [];
  let current = normalized;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) {
      return normalized;
    }
    trailingSegments.unshift(basename(current));
    current = parent;
    if (existsSync(current)) {
      try {
        return join(realpathSync(current), ...trailingSegments);
      } catch {
        return join(resolve(current), ...trailingSegments);
      }
    }
  }
}

/**
 * Resolve `candidatePath` and verify it lies under at least one allowed root.
 * Returns the resolved absolute path, or `undefined` when validation fails.
 */
export function resolveSafePath(candidatePath: string, allowedRoots: string[]): string | undefined {
  if (!candidatePath || !isAbsolute(candidatePath)) {
    logger.debug(`Rejected unsafe path (not absolute): ${candidatePath}`);
    return undefined;
  }

  let resolvedCandidate: string;
  try {
    resolvedCandidate = resolvePathPreservingSuffix(candidatePath);
  } catch (err) {
    logger.debug(`Rejected path (realpath failed): ${candidatePath}: ${(err as Error).message}`);
    return undefined;
  }

  for (const root of allowedRoots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = resolvePathPreservingSuffix(root);
    } catch {
      resolvedRoot = resolve(root);
    }

    const rel = relative(resolvedRoot, resolvedCandidate);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      return resolvedCandidate;
    }
  }

  logger.debug(`Rejected path outside safe roots: ${candidatePath}`);
  return undefined;
}
