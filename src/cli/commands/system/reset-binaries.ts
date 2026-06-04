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
import type { CliState } from '../../../lib/state';
import type { PhaseItem } from '../../../ui';
import { phaseItem } from '../../../ui';
import { stopAllContextAugmentationTools } from '../integrate/_common/context-augmentation';
import { resolveSafePath } from './safe-path';

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
  | { status: 'cleaned'; dependencyIds: string[]; toolNames: string[] }
  | { status: 'failed'; message: string };

export async function removeBinaries(state: CliState): Promise<BinaryResetResult> {
  const { plans, failed: planFailures } = buildRemovalPlans(state);
  const cleanedDependencyIds = new Set<string>();
  const cleanedToolNames = new Set<string>();
  const failed = [...planFailures];
  let removedPathCount = 0;

  for (const plan of plans) {
    const outcome = await tryRemoveBinaryAtPath(plan);
    if (outcome.status === 'cleaned') {
      removedPathCount += 1;
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
    item: buildBinaryPhaseItem(removedPathCount, failed),
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
    if (existsSync(safePath)) {
      rmSync(safePath, { force: true });
    }
    return {
      status: 'cleaned',
      dependencyIds: [...plan.dependencyIds],
      toolNames: [...plan.toolNames],
    };
  } catch (err) {
    return { status: 'failed', message: `${label}: ${(err as Error).message}` };
  }
}

function buildBinaryPhaseItem(removedCount: number, failed: string[]): PhaseItem {
  if (failed.length > 0) {
    const counts =
      removedCount > 0
        ? `${removedCount} removed, ${failed.length} failed`
        : `${failed.length} failed`;
    return phaseItem('Binaries', 'warn', `${counts}: ${failed.join('; ')}`);
  }

  if (removedCount > 0) {
    const label = removedCount === 1 ? 'binary' : 'binaries';
    return phaseItem('Binaries', 'done', `Removed ${removedCount} ${label} from ${BIN_DIR}.`);
  }

  return phaseItem('Binaries', 'info', 'Nothing to remove.');
}
