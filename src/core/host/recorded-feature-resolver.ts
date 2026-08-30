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

// Shared worktree-aware resolution of a recorded per-project feature; `discoverProject()`
// is the sole caller, so SQAA and CAG project lookups share one selection policy.

import { pathComparisonKey } from '../io/fs-utils.ts';
import { parseTimestampMillis } from '../time/timestamp.ts';
import type { LookupPath } from './git/lookup-path-resolver.ts';

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

/** A selected candidate plus the project root to use — always in the caller's own worktree, never a different one. */
export interface FeatureMatch<T> {
  feature: T;
  matchedPath: string;
}

/** Among candidates tied on an exact match, the most recently updated wins. */
function pickBest<T>(matches: KeyedCandidate<T>[]): T | undefined {
  return matches
    .slice()
    .sort((a, b) => parseTimestampMillis(b.updatedAt) - parseTimestampMillis(a.updatedAt))
    .at(0)?.feature;
}

/**
 * Pure, git-free exact-match selection over an already-resolved, nearest-first lookup-path
 * list. Per path: exact `targetRoot` match wins over `repoRoot`-only; ties broken by recency.
 */
export function selectFeatureForLookupPaths<T>(
  candidates: RecordedFeatureCandidate<T>[],
  lookupPaths: LookupPath[],
): FeatureMatch<T> | undefined {
  const keyed: KeyedCandidate<T>[] = candidates.map((candidate) => ({
    feature: candidate.feature,
    targetRoot: pathComparisonKey(candidate.targetRoot),
    repoRoot: candidate.repoRoot === undefined ? undefined : pathComparisonKey(candidate.repoRoot),
    updatedAt: candidate.updatedAt,
  }));

  for (const { checkPath, projectRoot } of lookupPaths) {
    const keyedPath = pathComparisonKey(checkPath);

    const byTarget = pickBest(keyed.filter((candidate) => candidate.targetRoot === keyedPath));
    if (byTarget) {
      return { feature: byTarget, matchedPath: projectRoot };
    }

    const byRepo = pickBest(keyed.filter((candidate) => candidate.repoRoot === keyedPath));
    if (byRepo) {
      return { feature: byRepo, matchedPath: projectRoot };
    }
  }
  return undefined;
}
