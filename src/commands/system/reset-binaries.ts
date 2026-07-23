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

import { CONTEXT_AUGMENTATION_BINARY_NAME } from '@/core/host/install-types.ts';
import type { PhaseItem } from '@/core/ui';
import { phaseItem } from '@/core/ui';

import { BIN_DIR } from '../../lib/config-constants.ts';
import type { CliState } from '../../lib/state.ts';
import { stopAllContextAugmentationTools } from '../integrate/_common/context-augmentation.ts';
import { resolveSafePath } from './safe-path.ts';

export interface BinaryResetResult {
  item: PhaseItem;
  dependencyIds: string[];
  toolNames: string[];
}

interface PathRemovalPlan {
  path: string;
  dependencyIds: Set<string>;
  toolNames: Set<string>;
}

type BinaryRemoveOutcome =
  | { status: 'cleaned'; fileRemoved: boolean; dependencyIds: string[]; toolNames: string[] }
  | { status: 'failed'; message: string };

export async function removeBinaries(state: CliState): Promise<BinaryResetResult> {
  const { plans, failed: planFailures } = buildRemovalPlans(state);
  const cleanedDependencyIds = new Set<string>();
  const cleanedToolNames = new Set<string>();
  const failed = [...planFailures];
  let removedFileCount = 0;
  let purgedStaleCount = 0;

  for (const plan of plans) {
    const outcome = await tryRemoveBinaryAtPath(plan);
    if (outcome.status === 'cleaned') {
      if (outcome.fileRemoved) {
        removedFileCount += 1;
      } else {
        purgedStaleCount += 1;
      }
      for (const id of outcome.dependencyIds) {
        cleanedDependencyIds.add(id);
      }
      for (const name of outcome.toolNames) {
        cleanedToolNames.add(name);
      }
    } else {
      failed.push(outcome.message);
    }
  }

  return {
    item: buildBinaryPhaseItem(removedFileCount, purgedStaleCount, failed),
    dependencyIds: [...cleanedDependencyIds],
    toolNames: [...cleanedToolNames],
  };
}

function buildRemovalPlans(state: CliState): {
  plans: PathRemovalPlan[];
  failed: string[];
} {
  const byPath = new Map<string, PathRemovalPlan>();
  const failed: string[] = [];

  for (const dep of state.dependencies.installed) {
    if (!dep.path) {
      failed.push(`${dep.id}: missing install path`);
      continue;
    }
    addPathTarget(byPath, dep.path, dep.id, undefined);
  }

  for (const tool of state.tools?.installed ?? []) {
    if (!tool.path) {
      failed.push(`${tool.name}: missing install path`);
      continue;
    }
    addPathTarget(byPath, tool.path, undefined, tool.name);
  }

  return { plans: [...byPath.values()], failed };
}

function addPathTarget(
  byPath: Map<string, PathRemovalPlan>,
  path: string,
  dependencyId: string | undefined,
  toolName: string | undefined,
): void {
  let plan = byPath.get(path);
  if (!plan) {
    plan = { path, dependencyIds: new Set(), toolNames: new Set() };
    byPath.set(path, plan);
  }
  if (dependencyId) {
    plan.dependencyIds.add(dependencyId);
  }
  if (toolName) {
    plan.toolNames.add(toolName);
  }
}

async function tryRemoveBinaryAtPath(plan: PathRemovalPlan): Promise<BinaryRemoveOutcome> {
  const label = [...plan.dependencyIds, ...plan.toolNames].join(', ') || plan.path;
  const safePath = resolveSafePath(plan.path, [BIN_DIR]);
  if (!safePath) {
    return { status: 'failed', message: `${label}: path rejected` };
  }

  const needsCagStop =
    plan.dependencyIds.has(CONTEXT_AUGMENTATION_BINARY_NAME) ||
    plan.toolNames.has(CONTEXT_AUGMENTATION_BINARY_NAME);
  if (needsCagStop && existsSync(safePath)) {
    await stopAllContextAugmentationTools(safePath);
  }

  try {
    const fileRemoved = existsSync(safePath);
    if (fileRemoved) {
      rmSync(safePath, { force: true });
    }
    return {
      status: 'cleaned',
      fileRemoved,
      dependencyIds: [...plan.dependencyIds],
      toolNames: [...plan.toolNames],
    };
  } catch (err) {
    return { status: 'failed', message: `${label}: ${(err as Error).message}` };
  }
}

function buildBinaryPhaseItem(
  removedFileCount: number,
  purgedStaleCount: number,
  failed: string[],
): PhaseItem {
  const totalCleaned = removedFileCount + purgedStaleCount;

  if (failed.length > 0) {
    const counts =
      totalCleaned > 0
        ? `${totalCleaned} removed, ${failed.length} failed`
        : `${failed.length} failed`;
    return phaseItem('Binaries', 'warn', `${counts}: ${failed.join('; ')}`);
  }

  if (removedFileCount > 0 && purgedStaleCount > 0) {
    const fileLabel = removedFileCount === 1 ? 'binary' : 'binaries';
    const staleLabel = purgedStaleCount === 1 ? 'entry' : 'entries';
    return phaseItem(
      'Binaries',
      'done',
      `Removed ${removedFileCount} ${fileLabel} from ${BIN_DIR} and cleared ${purgedStaleCount} stale ${staleLabel} from state.`,
    );
  }

  if (removedFileCount > 0) {
    const label = removedFileCount === 1 ? 'binary' : 'binaries';
    return phaseItem('Binaries', 'done', `Removed ${removedFileCount} ${label} from ${BIN_DIR}.`);
  }

  if (purgedStaleCount > 0) {
    const label = purgedStaleCount === 1 ? 'entry' : 'entries';
    return phaseItem(
      'Binaries',
      'done',
      `Cleared ${purgedStaleCount} stale binary ${label} from state.`,
    );
  }

  return phaseItem('Binaries', 'info', 'Nothing to remove.');
}
