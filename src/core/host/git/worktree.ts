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

// Git worktree awareness: resolves a repository's main working tree root for a given
// directory (see also the worktree-aware climb in `lookup-path-resolver.ts`).

import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { canonicalizePath } from '../../io/fs-utils.ts';
import { tryRunGit } from './exec.ts';

// Per-process cache of `git` stdout keyed by (cwd, args). A single CLI invocation can
// resolve worktree topology for the same directory more than once (e.g. the lookup-path
// climb checks both the current and main worktree), and that topology cannot change
// mid-invocation — so we spawn `git` at most once per distinct command. Each CLI run is
// a fresh process, so the cache never outlives a single invocation.
const gitStdoutCache = new Map<string, Promise<string | null>>();

function runGitStdout(args: string[], cwd: string): Promise<string | null> {
  const cacheKey = `${cwd} ${args.join(' ')}`;
  const cached = gitStdoutCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const pending = tryRunGit(args, cwd).then((stdout) => stdout ?? null);
  gitStdoutCache.set(cacheKey, pending);
  return pending;
}

/** Test-only: clear the per-process git stdout cache so mocked `git` calls aren't served stale results across test cases. */
export function clearGitStdoutCache(): void {
  gitStdoutCache.clear();
}

/** Directory to spawn `git` from for `contextPath`: its parent when it's a file, itself otherwise. */
function gitSpawnCwd(contextPath: string): string {
  try {
    return statSync(contextPath).isFile() ? dirname(contextPath) : contextPath;
  } catch {
    return contextPath;
  }
}

/**
 * Resolve the git repository top-level for `contextPath` (a file or directory)
 * via `rev-parse --show-toplevel`, canonicalized. This is more reliable than
 * inferring the current tree from `git worktree list` alone, especially on
 * Windows where path forms from git output and `process.cwd()` can disagree
 * (short vs long paths, slash direction, extended `\\?\` prefixes). Returns
 * `null` when git is unavailable or `contextPath` is not inside a repository.
 */
export async function resolveGitRepoRoot(contextPath: string): Promise<string | null> {
  const topLevel = await runGitStdout(['rev-parse', '--show-toplevel'], gitSpawnCwd(contextPath));
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
