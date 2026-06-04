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

import { BIN_DIR } from '../../../lib/config-constants';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../lib/install-types';
import type { CliState, InstalledIntegrationDependency } from '../../../lib/state';
import type { PhaseItem } from '../../../ui';
import { phaseItem } from '../../../ui';
import { stopAllContextAugmentationTools } from '../integrate/_common/context-augmentation';
import { resolveSafePath } from './safe-path';

export interface BinaryResetResult {
  item: PhaseItem;
  dependencyIds: string[];
}

type DependencyRemoveOutcome =
  | { status: 'skipped' }
  | { status: 'cleaned'; id: string }
  | { status: 'failed'; message: string };

export async function removeBinaries(state: CliState): Promise<BinaryResetResult> {
  const cleanedIds: string[] = [];
  const failed: string[] = [];

  for (const dep of state.dependencies.installed) {
    const outcome = await tryRemoveDependency(dep);
    if (outcome.status === 'cleaned') {
      cleanedIds.push(outcome.id);
    } else if (outcome.status === 'failed') {
      failed.push(outcome.message);
    }
  }

  return {
    item: buildBinaryPhaseItem(cleanedIds, failed),
    dependencyIds: cleanedIds,
  };
}

async function tryRemoveDependency(
  dep: InstalledIntegrationDependency,
): Promise<DependencyRemoveOutcome> {
  if (!dep.path) {
    return { status: 'skipped' };
  }

  const safePath = resolveSafePath(dep.path, [BIN_DIR]);
  if (!safePath) {
    return { status: 'failed', message: `${dep.id}: path rejected` };
  }

  if (dep.id === CONTEXT_AUGMENTATION_BINARY_NAME && existsSync(safePath)) {
    await stopAllContextAugmentationTools(safePath);
  }

  try {
    if (existsSync(safePath)) {
      rmSync(safePath, { force: true });
    }
    return { status: 'cleaned', id: dep.id };
  } catch (err) {
    return { status: 'failed', message: `${dep.id}: ${(err as Error).message}` };
  }
}

function buildBinaryPhaseItem(cleanedIds: string[], failed: string[]): PhaseItem {
  if (failed.length > 0) {
    const counts =
      cleanedIds.length > 0
        ? `${cleanedIds.length} removed, ${failed.length} failed`
        : `${failed.length} failed`;
    return phaseItem('Binaries', 'warn', `${counts}: ${failed.join('; ')}`);
  }

  if (cleanedIds.length > 0) {
    const label = cleanedIds.length === 1 ? 'binary' : 'binaries';
    return phaseItem('Binaries', 'done', `Removed ${cleanedIds.length} ${label} from ${BIN_DIR}.`);
  }

  return phaseItem('Binaries', 'info', 'Nothing to remove.');
}
