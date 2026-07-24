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

// Shared git worktree helpers (repo root, current branch).

import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import logger from '@/core/observability/logger.ts';
import { spawnProcess } from '@/core/process/process.ts';

/**
 * Returns the repository top-level for `contextPath`, or `undefined` when not in a repo
 * or git is unavailable. `contextPath` may be a file or directory.
 */
export async function resolveGitRepoRoot(contextPath: string): Promise<string | undefined> {
  const out = await tryRunGit(['rev-parse', '--show-toplevel'], gitSpawnCwd(contextPath));
  if (out === undefined) return undefined;
  return resolve(out.trim());
}

/**
 * Returns the current branch name for a path inside a repository, or `undefined`
 * when not in a repo, git is unavailable, or HEAD is detached.
 *
 * `contextPath` may be a file or directory; git commands run from the resolved
 * repository root. Uses `git branch --show-current` (Git >= 2.22) with a
 * fallback to `git rev-parse --abbrev-ref HEAD` for older Git versions.
 */
export async function resolveCurrentGitBranch(contextPath: string): Promise<string | undefined> {
  const repoRoot = await resolveGitRepoRoot(contextPath);
  if (!repoRoot) return undefined;

  const branch = await resolveGitBranchAtRepoRoot(repoRoot);
  if (branch === undefined) {
    logger.debug(
      'Git branch auto-detection skipped: no named branch (detached HEAD, old Git, or git unavailable).',
    );
  }
  return branch;
}

/** Returns the current branch at an already-resolved repository root. */
export async function resolveGitBranchAtRepoRoot(repoRoot: string): Promise<string | undefined> {
  let branch = await tryRunGit(['branch', '--show-current'], repoRoot);
  branch ??= await tryRunGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (branch === undefined) return undefined;
  const trimmed = branch.trim();
  if (trimmed.length === 0 || trimmed === 'HEAD') return undefined;
  return trimmed;
}

function gitSpawnCwd(contextPath: string): string {
  try {
    return statSync(contextPath).isFile() ? dirname(contextPath) : contextPath;
  } catch {
    return contextPath;
  }
}

async function tryRunGit(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const result = await spawnProcess('git', args, { cwd });
    if (result.exitCode !== 0) return undefined;
    return result.stdout;
  } catch {
    return undefined;
  }
}
