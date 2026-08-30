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

// Resolves the explicit, ordered list of directories to check for a recorded per-project
// mapping, handling git/non-git and current-vs-main-worktree internally.

import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { canonicalizePath, isAncestorOrSelf, pathComparisonKey } from '@/core/io/fs-utils.ts';

import { resolveGitRepoRoot, resolveMainWorktreeRoot } from './worktree.ts';

/** Pure, git-free: walks `dirname()` from `from` up to `upToInclusive` (or the filesystem root when omitted). */
export function buildDirectoryClimb(from: string, upToInclusive?: string): string[] {
  const boundKey = upToInclusive === undefined ? undefined : pathComparisonKey(upToInclusive);
  const climb: string[] = [];

  let current = canonicalizePath(from);
  for (;;) {
    climb.push(current);
    if (boundKey !== undefined && pathComparisonKey(current) === boundKey) {
      break;
    }
    const parent = dirname(current);
    if (pathComparisonKey(parent) === pathComparisonKey(current)) {
      break; // reached the filesystem/drive root
    }
    current = parent;
  }

  return climb;
}

/** Maps `dir`'s offset inside `fromRoot` onto the equivalent location under `toRoot`. */
function mapOffset(dir: string, fromRoot: string, toRoot: string): string | undefined {
  const rel = relative(fromRoot, dir);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined;
  }
  return rel === '' ? toRoot : canonicalizePath(join(toRoot, rel));
}

/** A directory to check candidates against (`checkPath`), and the `projectRoot` to use if it matches — these differ only for the main-tree-equivalent climb, where `projectRoot` stays in the current worktree instead of pointing at the main one. */
export interface LookupPath {
  checkPath: string;
  projectRoot: string;
}

function asLookupPaths(paths: string[]): LookupPath[] {
  return paths.map((checkPath) => ({ checkPath, projectRoot: checkPath }));
}

/** Shallowest ancestor-or-self of `dir` among the raw, un-deduplicated `knownRoots`. */
function findBoundingKnownRoot(dir: string, knownRoots: string[]): string | undefined {
  let shallowest: string | undefined;
  for (const root of knownRoots) {
    const canonicalRoot = canonicalizePath(root);
    if (
      isAncestorOrSelf(canonicalRoot, dir) &&
      (shallowest === undefined || canonicalRoot.length < shallowest.length)
    ) {
      shallowest = canonicalRoot;
    }
  }
  return shallowest;
}

/** Nearest-first directories to check for `startDir`: repo-root climb in git, else bounded by the shallowest matching `knownRoots` entry (or `startDir` itself); appends the main-tree-equivalent climb from a linked worktree. */
export async function resolveLookupPaths(
  startDir: string,
  knownRoots: string[] = [],
): Promise<LookupPath[]> {
  const canonicalStart = canonicalizePath(startDir);
  const currentRepoRoot = await resolveGitRepoRoot(canonicalStart);
  if (!currentRepoRoot) {
    const bound = findBoundingKnownRoot(canonicalStart, knownRoots) ?? canonicalStart;
    return asLookupPaths(buildDirectoryClimb(canonicalStart, bound));
  }

  const climb = buildDirectoryClimb(canonicalStart, currentRepoRoot);

  const mainRepoRoot = await resolveMainWorktreeRoot(canonicalStart);
  if (!mainRepoRoot || pathComparisonKey(mainRepoRoot) === pathComparisonKey(currentRepoRoot)) {
    return asLookupPaths(climb);
  }

  const mappedStart = mapOffset(canonicalStart, currentRepoRoot, mainRepoRoot);
  if (mappedStart === undefined) {
    return asLookupPaths(climb);
  }

  // climb[i] and mainTreeClimb[i] are the same relative depth, so climb[i] is the
  // current-worktree equivalent of whatever mainTreeClimb[i] checks in the main tree.
  const mainTreeClimb = buildDirectoryClimb(mappedStart, mainRepoRoot);
  const mainTreeLookupPaths = mainTreeClimb.map((checkPath, i) => ({
    checkPath,
    projectRoot: climb[i] ?? checkPath,
  }));

  return [...asLookupPaths(climb), ...mainTreeLookupPaths];
}
