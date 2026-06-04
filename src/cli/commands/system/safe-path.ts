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
import { isAbsolute, relative, resolve } from 'node:path';

import logger from '../../../lib/logger';

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
    resolvedCandidate = existsSync(candidatePath)
      ? realpathSync(candidatePath)
      : resolve(candidatePath);
  } catch (err) {
    logger.debug(`Rejected path (realpath failed): ${candidatePath}: ${(err as Error).message}`);
    return undefined;
  }

  for (const root of allowedRoots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = existsSync(root) ? realpathSync(root) : resolve(root);
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
