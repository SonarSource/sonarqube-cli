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

import { CLI_DIR, getStatsDir } from '@/core/config-constants.ts';
import { type PhaseItem, phaseItem } from '@/core/ui/console.ts';

import { directorySizeBytes, formatByteSize } from './dir-size.ts';
import { resolveSafePath } from './safe-path.ts';

export interface StatsResetResult {
  item: PhaseItem;
}

/** Wipes the local `sonar stats` SQLite ledger outright, as its own reported step
 *  rather than folded into the generic filesystem-cache clear. */
export function clearStats(): StatsResetResult {
  const statsDir = resolveSafePath(getStatsDir(), [CLI_DIR]);
  if (!statsDir) {
    return { item: phaseItem('Stats', 'warn', 'Failed to clear stats database: path rejected') };
  }

  if (!existsSync(statsDir)) {
    return { item: phaseItem('Stats', 'info', 'Nothing to clear.') };
  }

  try {
    const bytesFreed = directorySizeBytes(statsDir);
    rmSync(statsDir, { recursive: true, force: true });
    const sizeLabel = bytesFreed > 0 ? ` (${formatByteSize(bytesFreed)} cleared)` : '';
    return { item: phaseItem('Stats', 'done', `Cleared local stats database${sizeLabel}.`) };
  } catch (err) {
    return {
      item: phaseItem('Stats', 'warn', `Failed to clear stats database: ${(err as Error).message}`),
    };
  }
}
