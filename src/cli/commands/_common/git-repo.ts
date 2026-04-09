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
import { CommandFailedError } from './error';
import { spawnProcess } from '../../../lib/process';
import { PRE_COMMIT_CONFIG_FILE } from '../integrate/git/git-precommit-framework';
import { normalizePath } from '../../../lib/fs-utils';

/**
 * Resolves the directory git uses for hooks (core.hooksPath or .git/hooks).
 */
export async function resolveGitHooksDir(root: string): Promise<string> {
  let configResult;
  try {
    configResult = await spawnProcess('git', ['config', 'core.hooksPath'], { cwd: root });
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
    // .git is a file (worktree) or missing — use git rev-parse
  }

  let result;
  try {
    result = await spawnProcess('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandFailedError(`Failed to run git [${message}]`);
  }
  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout].filter((s) => s.length > 0).join('\n');
    throw new CommandFailedError(
      `Could not resolve git hooks directory (exit code ${result.exitCode}) ${detail}`,
    );
  }
  const resolved = result.stdout.trim();
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
    this._hooksDir ??= resolveGitHooksDir(this.rootDir);
    return this._hooksDir;
  }

  /** True if git's hooks path points to .husky (Husky is in use). */
  async usesHusky(): Promise<boolean> {
    const hooksDir = await this.getHooksDirOnce();
    return normalizePath(hooksDir).startsWith(normalizePath(join(this.rootDir, '.husky')));
  }

  /** Resolved git hooks directory (core.hooksPath or .git/hooks). */
  async getHooksDir(): Promise<string> {
    return this.getHooksDirOnce();
  }

  /** Path to the Husky hook file for the given hook name (e.g. 'pre-commit', 'pre-push'). */
  getHuskyHookPath(hook: string): string {
    return join(this.rootDir, '.husky', hook);
  }
}
