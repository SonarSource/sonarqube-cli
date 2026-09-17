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

// Git repository abstraction for hook installation: root dir, hooks path, and framework detection.

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';

import { normalizePath } from '../../io/fs-utils.ts';
import { spawnProcess } from '../../process/process.ts';

/** Filename used by the `pre-commit` framework (https://pre-commit.com) for its config. */
export const PRE_COMMIT_CONFIG_FILE = '.pre-commit-config.yaml';

/**
 * Fallback strategy used once no `core.hooksPath` config is found: how to run git and how to
 * turn its output into the hooks dir.
 */
interface HooksDirFallback {
  command: string[];
  resolveFromOutput: (output: string) => string;
}

/**
 * Resolves the directory git uses for hooks, from the repository's own config only
 * (core.hooksPath or .git/hooks) — never an inherited global/system core.hooksPath, since a
 * repo-scoped install must not follow (or overwrite) a hooks path configured for every repo.
 */
export async function resolveLocalGitHooksDir(root: string): Promise<string> {
  return resolveGitHooksDirWithConfigScope(root, ['config', '--local', 'core.hooksPath'], {
    // In a linked worktree or submodule, `.git` is a file rather than a directory, so the
    // statSync-based fast path below can't apply — the fallback command matters there.
    // `--git-path hooks` (used by the effective resolver below) follows an inherited
    // core.hooksPath, which would leak the global value back in exactly the case this
    // function exists to avoid; `--git-common-dir` never does, and hooks always live under
    // the *common* dir (shared by every worktree of the same repo), never a per-worktree one.
    command: ['rev-parse', '--git-common-dir'],
    resolveFromOutput: (commonDir) => join(commonDir, 'hooks'),
  });
}

/**
 * Resolves the directory git will *actually* use for hooks in this repo right now — the
 * effective `core.hooksPath` (local, else inherited global/system), else `.git/hooks`. Only
 * for diagnostics (e.g. warning that a `--local` install is shadowed by an inherited value);
 * installing a hook must always target {@link resolveLocalGitHooksDir} instead.
 */
export async function resolveEffectiveGitHooksDir(root: string): Promise<string> {
  return resolveGitHooksDirWithConfigScope(root, ['config', 'core.hooksPath'], {
    command: ['rev-parse', '--git-path', 'hooks'],
    resolveFromOutput: (output) => output,
  });
}

async function resolveGitHooksDirWithConfigScope(
  root: string,
  configCommand: string[],
  fallback: HooksDirFallback,
): Promise<string> {
  let configResult;
  try {
    configResult = await spawnProcess('git', configCommand, { cwd: root });
  } catch {
    configResult = null;
  }
  if (configResult?.exitCode === 0) {
    const configured = configResult.stdout.trim();
    if (configured) {
      return isAbsolute(configured) ? configured : join(root, configured);
    }
  }

  const dotGit = join(root, '.git');
  try {
    if (statSync(dotGit).isDirectory()) {
      return join(dotGit, 'hooks');
    }
  } catch {
    // .git is a file (worktree/submodule) or missing — resolve via the fallback command
  }

  let result;
  try {
    result = await spawnProcess('git', fallback.command, { cwd: root });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandFailedError(`Failed to run git [${message}]`, {
      remediationHint:
        'Ensure git is installed and available on PATH, then retry from a git repository.',
    });
  }
  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout].filter((s) => s.length > 0).join('\n');
    throw new CommandFailedError(
      `Could not resolve git hooks directory (exit code ${result.exitCode}) ${detail}`,
      {
        remediationHint:
          'Make sure you run this command inside a valid git repository, and check that the repository metadata (.git directory or worktree pointer) is not corrupted, then retry.',
      },
    );
  }
  const resolved = fallback.resolveFromOutput(result.stdout.trim());
  return isAbsolute(resolved) ? resolved : join(root, resolved);
}

/**
 * Represents a git repository at a given root. Use to decide hook installation strategy
 * without resolving all state up front (e.g. only resolve hooks dir when not using pre-commit).
 */
export class GitRepo {
  readonly rootDir: string;
  private _hooksDir: Promise<string> | null = null;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  /** True if the repo uses the pre-commit framework (.pre-commit-config.yaml). */
  usesPreCommitFramework(): boolean {
    return existsSync(join(this.rootDir, PRE_COMMIT_CONFIG_FILE));
  }

  private async getHooksDirOnce(): Promise<string> {
    this._hooksDir ??= resolveLocalGitHooksDir(this.rootDir);
    return this._hooksDir;
  }

  /** True if git's hooks path points to .husky (Husky is in use). */
  async usesHusky(): Promise<boolean> {
    const hooksDir = await this.getHooksDirOnce();
    return normalizePath(hooksDir).startsWith(normalizePath(join(this.rootDir, '.husky')));
  }

  /** Resolved local git hooks directory (core.hooksPath or .git/hooks); never an inherited global value. */
  async getHooksDir(): Promise<string> {
    return this.getHooksDirOnce();
  }

  /** Path to the Husky hook file for the given hook name (e.g. 'pre-commit', 'pre-push'). */
  getHuskyHookPath(hook: string): string {
    return join(this.rootDir, '.husky', hook);
  }
}
