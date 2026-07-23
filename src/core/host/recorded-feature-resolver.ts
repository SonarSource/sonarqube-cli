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

// Shared worktree-aware resolution of a recorded per-project integration feature
// for a working directory. Both `sonar analyze agentic` (SQAA project-key lookup)
// and the `sonar context` passthrough (CAG connection lookup) map the current
// directory to the recorded feature that governs it, so they share this single
// selection policy to guarantee identical behavior.

import { sep } from 'node:path';

import { resolveWorktreeEquivalentPaths } from '@/core/host/git-worktree.ts';

import { pathComparisonKey } from '../../lib/fs-utils.ts';

/**
 * A recorded feature paired with the roots used to match it to a directory.
 * `T` is whatever the caller wants back on a match (typically the feature itself).
 */
export interface RecordedFeatureCandidate<T> {
  /** Value returned to the caller when this candidate is selected. */
  feature: T;
  /** Physical install dir — the precise, workspace-specific signal. */
  targetRoot: string;
  /** Recorded main-working-tree identity — the worktree-wide fallback (absent on older state). */
  repoRoot?: string;
  /** ISO timestamp used as the final recency tie-break; absent/unparseable sorts last. */
  updatedAt?: string;
}

interface KeyedCandidate<T> {
  feature: T;
  targetRoot: string;
  repoRoot: string | undefined;
  updatedAt: string | undefined;
}

function updatedAtMillis(iso: string | undefined): number {
  if (iso === undefined) {
    return 0;
  }
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * True when `parent` equals or is an ancestor of `child`. Both arguments must
 * already be canonical comparison keys (see `pathComparisonKey`): absolute,
 * `..`-free, and case-folded consistently. That invariant is what makes a plain
 * boundary-aware prefix check correct and robust:
 *  - canonicalization has already collapsed any real `..` traversal, so there is
 *    no relative-path string to misread — a child literally named `..config`
 *    stays inside `parent` (`/a/..config` starts with `/a/`);
 *  - appending the separator keeps `/a` from matching a sibling `/ab`.
 */
function isPathInside(parent: string, child: string): boolean {
  if (parent === child) {
    return true;
  }
  const boundary = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(boundary);
}

/**
 * Among features whose given root is an ancestor of (or equal to) a lookup path,
 * pick the most specific (longest root), then the most recently updated.
 */
function pickBest<T>(matches: { candidate: KeyedCandidate<T>; root: string }[]): T | undefined {
  return matches
    .slice()
    .sort(
      (a, b) =>
        b.root.length - a.root.length ||
        updatedAtMillis(b.candidate.updatedAt) - updatedAtMillis(a.candidate.updatedAt),
    )
    .at(0)?.candidate.feature;
}

/**
 * Pure selection over already-resolved lookup paths (ordered current-worktree
 * first, then main working tree). Exposed separately from
 * `selectRecordedFeatureForDir` so the policy can be unit-tested without git.
 *
 * For each lookup path in order:
 *  1. an exact/ancestor `targetRoot` match (the physical install dir) wins over
 *     a `repoRoot`-only match, so two worktrees integrated with different project
 *     keys resolve to the one actually installed here rather than a sibling that
 *     merely shares the same main working tree;
 *  2. among same-kind matches the longest (most specific) root wins, then the
 *     most recently updated feature, so nested (monorepo) integrations resolve to
 *     the nearest ancestor.
 *
 * Consulting the current worktree before the main tree means a call from a linked
 * worktree prefers that worktree's own integration but still falls back to the
 * main checkout's when the worktree itself was never integrated.
 */
export function selectFeatureForLookupPaths<T>(
  candidates: RecordedFeatureCandidate<T>[],
  lookupPaths: string[],
): T | undefined {
  const keyedPaths = lookupPaths.map((path) => pathComparisonKey(path));
  const keyed: KeyedCandidate<T>[] = candidates.map((candidate) => ({
    feature: candidate.feature,
    targetRoot: pathComparisonKey(candidate.targetRoot),
    repoRoot: candidate.repoRoot === undefined ? undefined : pathComparisonKey(candidate.repoRoot),
    updatedAt: candidate.updatedAt,
  }));

  for (const path of keyedPaths) {
    const byTarget = pickBest(
      keyed.flatMap((candidate) =>
        isPathInside(candidate.targetRoot, path) ? [{ candidate, root: candidate.targetRoot }] : [],
      ),
    );
    if (byTarget) {
      return byTarget;
    }

    const byRepo = pickBest(
      keyed.flatMap((candidate) =>
        candidate.repoRoot !== undefined && isPathInside(candidate.repoRoot, path)
          ? [{ candidate, root: candidate.repoRoot }]
          : [],
      ),
    );
    if (byRepo) {
      return byRepo;
    }
  }
  return undefined;
}

/**
 * Worktree-aware selection of the recorded feature governing `dir`. Resolves the
 * lookup paths for `dir` (`dir` itself, plus its equivalent in the main working
 * tree when inside a linked worktree) via a single `git worktree list` call, then
 * applies {@link selectFeatureForLookupPaths}. Returns undefined when nothing
 * matches (including when git is unavailable and no candidate contains `dir`).
 */
export async function selectRecordedFeatureForDir<T>(
  dir: string,
  candidates: RecordedFeatureCandidate<T>[],
): Promise<T | undefined> {
  const lookupPaths = await resolveWorktreeEquivalentPaths(dir);
  return selectFeatureForLookupPaths(candidates, lookupPaths);
}
