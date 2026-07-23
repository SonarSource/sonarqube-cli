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

// Local git repository discovery: walk up from a directory to find the .git
// root, and read its `origin` remote URL.

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import logger from '../../lib/logger.ts';
import { spawnProcess } from '../../lib/process.ts';

export function findGitRoot(startDir: string): { gitRoot: string; isGit: boolean } {
  let dir = startDir;

  for (;;) {
    const gitDir = join(dir, '.git');

    if (existsSync(gitDir)) {
      const stat = statSync(gitDir);
      // Accept both directory (.git/) and file (.git worktree pointer)
      if (stat.isDirectory() || stat.isFile()) {
        return { gitRoot: dir, isGit: true };
      }
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return { gitRoot: '', isGit: false };
}

export async function getGitRemote(gitRoot: string): Promise<string> {
  try {
    const result = await spawnProcess('git', ['remote', 'get-url', 'origin'], { cwd: gitRoot });
    if (result.exitCode === 0) {
      return result.stdout.trim();
    }
  } catch (error) {
    logger.debug(`Failed to get git remote: ${(error as Error).message}`);
  }
  return '';
}
