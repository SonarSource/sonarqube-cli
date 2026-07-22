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

import { existsSync, rmSync } from 'node:fs';

import type { PhaseItem } from '@/core/ui';
import { phaseItem } from '@/core/ui';

import {
  CLI_DIR,
  CLI_TMP_DIR,
  GLOBAL_HOOKS_DIR,
  LOG_DIR,
  SCA_SCANNER_CACHE_DIR,
} from '../../lib/config-constants.ts';
import { directorySizeBytes, formatByteSize } from './dir-size.ts';
import { resolveSafePath } from './safe-path.ts';

export interface FilesystemResetResult {
  item: PhaseItem;
}

const CACHE_DIRS = [LOG_DIR, SCA_SCANNER_CACHE_DIR, GLOBAL_HOOKS_DIR, CLI_TMP_DIR];

export function clearFilesystem(): FilesystemResetResult {
  const failed: string[] = [];
  let bytesFreed = 0;
  let removedCount = 0;

  for (const dir of CACHE_DIRS) {
    const safeDir = resolveSafePath(dir, [CLI_DIR]);
    if (!safeDir) {
      failed.push(`${dir}: path rejected`);
      continue;
    }

    try {
      if (existsSync(safeDir)) {
        const dirBytes = directorySizeBytes(safeDir);
        rmSync(safeDir, { recursive: true, force: true });
        bytesFreed += dirBytes;
        removedCount += 1;
      }
    } catch (err) {
      failed.push(`${dir}: ${(err as Error).message}`);
    }
  }

  let item: PhaseItem;
  if (failed.length > 0) {
    item = phaseItem(
      'Filesystem',
      'warn',
      `Failed to clear some directories: ${failed.join('; ')}`,
    );
  } else if (removedCount > 0) {
    const sizeLabel = bytesFreed > 0 ? ` (${formatByteSize(bytesFreed)} cleared)` : '';
    item = phaseItem('Filesystem', 'done', `Cleared CLI cache and logs${sizeLabel}.`);
  } else {
    item = phaseItem('Filesystem', 'info', 'Nothing to clear.');
  }

  return { item };
}
