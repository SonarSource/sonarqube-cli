/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Shared git helpers for hook integration tests.
// All functions use an absolute git binary path to avoid PATH-based resolution (S4036).

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolve git binary once at module load — avoids PATH reliance in execFileSync calls.
export const GIT_BIN = Bun.which('git') ?? '/usr/bin/git';

const NON_WINDOWS_GIT_TIMEOUT_MS = 15_000;
/** Hung `git add` must die before Bun's ~5s beforeEach timeout. */
const WINDOWS_QUICK_GIT_TIMEOUT_MS = 1_000;
/**
 * `git worktree add` copies the tree and routinely exceeds the quick cap on
 * Windows. Killing it mid-flight leaves the new branch behind, so the retry
 * fails with "a branch named 'feature/x' already exists".
 */
const WINDOWS_SLOW_GIT_TIMEOUT_MS = 15_000;

function gitCommandTimeoutMs(args: string[]): number {
  if (process.platform !== 'win32') {
    return NON_WINDOWS_GIT_TIMEOUT_MS;
  }
  return args[0] === 'worktree' ? WINDOWS_SLOW_GIT_TIMEOUT_MS : WINDOWS_QUICK_GIT_TIMEOUT_MS;
}

/**
 * Windows CI intermittently fails git commands against a freshly-created repo
 * with ERROR_ACCESS_DENIED (exit status 5) or a busy/locked file (EBUSY/EPERM/
 * EACCES) when the virus scanner or search indexer briefly holds a handle on a
 * file under the new `.git` directory. Spawn timeouts are only retried for
 * idempotent commands — `worktree`/`commit` mutate refs, so a SIGTERM retry
 * races the partial result. Anything else is rethrown immediately.
 */
function isTransientWindowsGitError(error: unknown, args: string[]): boolean {
  if (process.platform !== 'win32') {
    return false;
  }
  const { status, code, signal, killed } = error as {
    status?: number | null;
    code?: string;
    signal?: string | null;
    killed?: boolean;
  };
  if (status === 5 || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return true;
  }
  const timedOut = code === 'ETIMEDOUT' || signal === 'SIGTERM' || killed === true;
  if (!timedOut) {
    return false;
  }
  const command = args[0];
  return command !== 'worktree' && command !== 'commit';
}

export function git(args: string[], cwd: string): string {
  const maxAttempts = process.platform === 'win32' ? 5 : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      // stderr is piped (not ignored) so a real failure carries git's message.
      return execFileSync(GIT_BIN, args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: gitCommandTimeoutMs(args),
      }).trim();
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientWindowsGitError(error, args)) {
        throw error;
      }
      Bun.sleepSync(50 * attempt);
    }
  }
}

/** Initialise a new git repo in cwd (creates the directory if needed). */
export function initGitRepo(cwd: string): void {
  mkdirSync(cwd, { recursive: true });
  git(['init'], cwd);
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test User'], cwd);
}

/** Write a file, stage + commit it, and return the commit SHA. */
export function commitFile(cwd: string, filename: string, content: string): string {
  writeFileSync(join(cwd, filename), content, 'utf-8');
  git(['add', filename], cwd);
  git(['commit', '-m', `add ${filename}`], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

/** Write a file and stage it (without committing). */
export function stageFile(cwd: string, filename: string, content: string): void {
  writeFileSync(join(cwd, filename), content, 'utf-8');
  git(['add', filename], cwd);
}
