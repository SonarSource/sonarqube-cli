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

// Git worktree awareness: map a path inside a linked worktree back to the
// equivalent path in the repository's main working tree, so per-project state
// recorded by `sonar integrate` in the main checkout can still be found after a
// worktree is created (e.g. for SQAA project-key and CAG context lookups).

import { isAbsolute, join, relative, resolve } from 'node:path';

import { canonicalizePath, pathComparisonKey } from '../../lib/fs-utils.ts';
import { spawnProcess } from '../../lib/process.ts';

interface WorktreeMapping {
  /** git top-level of the input path (the linked worktree root when inside one). */
  currentRoot: string;
  /** Main working tree root; differs from currentRoot only inside a linked worktree. */
  mainRoot: string;
}

// Per-process cache of `git` stdout keyed by (cwd, args). A single CLI
// invocation resolves worktree topology for the same directory several times
// (e.g. `sonar context` maps cwd both to match recorded features and to derive
// the workspace root), and that topology cannot change mid-invocation — so we
// spawn `git` at most once per distinct command. Each CLI run is a fresh
// process, so the cache never outlives a single invocation.
const gitStdoutCache = new Map<string, Promise<string | null>>();

function runGitStdout(args: string[], cwd: string): Promise<string | null> {
  const cacheKey = `${cwd} ${args.join(' ')}`;
  const cached = gitStdoutCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const pending = runGitStdoutUncached(args, cwd);
  gitStdoutCache.set(cacheKey, pending);
  return pending;
}

async function runGitStdoutUncached(args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await spawnProcess('git', args, { cwd });
    if (result.exitCode === 0) {
      return result.stdout;
    }
  } catch {
    // git not installed, or `cwd` is not inside a repository — caller falls back.
  }
  return null;
}

/**
 * Resolve the git top-level for `dir` via `rev-parse --show-toplevel`. This is
 * more reliable than inferring the current tree from `git worktree list` alone,
 * especially on Windows where path forms from git output and `process.cwd()` can
 * disagree (short vs long paths, slash direction, extended `\\?\` prefixes).
 */
async function resolveGitTopLevel(dir: string): Promise<string | null> {
  const topLevel = await runGitStdout(['rev-parse', '--show-toplevel'], dir);
  if (topLevel === null) {
    return null;
  }
  const trimmed = topLevel.trim();
  return trimmed.length > 0 ? canonicalizePath(resolve(trimmed)) : null;
}

/**
 * List every working-tree root of the repository containing `dir`, in git's
 * order (the main working tree is always first). A single `git worktree list
 * --porcelain` yields both the main tree and every linked worktree, so all
 * worktree resolution below needs just this one git invocation. Returns null
 * when git is unavailable or `dir` is not inside a repository.
 */
async function listWorktreeRoots(dir: string): Promise<string[] | null> {
  const listing = await runGitStdout(['worktree', 'list', '--porcelain'], dir);
  if (listing === null) {
    return null;
  }
  const roots = listing
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => canonicalizePath(resolve(line.slice('worktree '.length).trim())))
    .filter((path) => path.length > 0);
  return roots.length > 0 ? roots : null;
}

/**
 * Resolve the absolute path of the repository's main working tree for the given
 * directory — the first `git worktree list` entry, which is the stable checkout
 * where `sonar integrate` should key per-project state (it outlives any linked
 * worktree). Returns null when git is unavailable or the directory is not inside
 * a repository.
 */
export async function resolveMainWorktreeRoot(dir: string): Promise<string | null> {
  const roots = await listWorktreeRoots(dir);
  return roots?.[0] ?? null;
}

/**
 * Resolve the current git top-level and the repository's main working tree root
 * for the given directory. The current root comes from `git rev-parse
 * --show-toplevel` (climbs up from subdirectories automatically). The main root
 * is the first `git worktree list` entry when available, otherwise the current
 * root. Returns null when git is unavailable or `dir` is not inside a repository;
 * when not inside a linked worktree, currentRoot equals mainRoot.
 */
async function resolveWorktreeMapping(dir: string): Promise<WorktreeMapping | null> {
  const currentRoot = await resolveGitTopLevel(dir);
  if (!currentRoot) {
    return null;
  }
  const roots = await listWorktreeRoots(dir);
  const mainRoot = roots?.[0] ?? currentRoot;
  return { currentRoot, mainRoot };
}

/**
 * Given a filesystem `path` inside a git working tree, return the de-duplicated
 * list of equivalent paths to consult for per-project state lookups: `path`
 * itself, plus its equivalent inside the repository's main working tree when
 * `path` is inside a linked worktree. Order is [current, main].
 *
 * Preserves the in-worktree offset (a subdirectory maps to the same subdirectory
 * under the main tree), so callers that match by prefix keep subfolder precision.
 * Falls back to `[path]` when git is unavailable, `path` is not inside a linked
 * worktree, or `path` is outside the current worktree root.
 */
export async function resolveWorktreeEquivalentPaths(path: string): Promise<string[]> {
  const mapping = await resolveWorktreeMapping(path);
  const canonicalPath = canonicalizePath(path);
  if (!mapping || mapping.currentRoot === mapping.mainRoot) {
    return [canonicalPath];
  }

  const rel = relative(mapping.currentRoot, canonicalPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return [canonicalPath];
  }

  const mapped = rel === '' ? mapping.mainRoot : canonicalizePath(join(mapping.mainRoot, rel));
  return pathComparisonKey(mapped) === pathComparisonKey(canonicalPath)
    ? [canonicalPath]
    : [canonicalPath, mapped];
}

/**
 * Stable repository identity key for per-project integration state: the main
 * working tree when inside a git repo, otherwise `projectRoot` itself.
 */
export async function resolveRecordedRepoRoot(projectRoot: string): Promise<string> {
  return (await resolveMainWorktreeRoot(projectRoot)) ?? projectRoot;
}

/**
 * Workspace root for CAG: the git working-tree root containing `cwd` when inside a
 * repository (climbs up from subdirectories), otherwise the physical integrate
 * `targetRoot` supplied by the caller.
 */
export async function resolveContextWorkspaceRoot(
  cwd: string,
  integratedTargetRoot: string,
): Promise<string> {
  const mapping = await resolveWorktreeMapping(cwd);
  if (mapping) {
    return mapping.currentRoot;
  }
  return integratedTargetRoot;
}
