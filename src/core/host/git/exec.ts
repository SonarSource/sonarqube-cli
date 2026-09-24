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

// Shared low-level git process runners used by every helper in this folder:
// run `git <args>` in `cwd` and return its output on success, or `undefined`
// when git is unavailable or exits non-zero.

import { spawnProcess } from '../../process/process.ts';

export async function tryRunGit(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const result = await spawnProcess('git', args, { cwd });
    if (result.exitCode !== 0) return undefined;
    return result.stdout;
  } catch {
    return undefined;
  }
}

/** Non-empty lines of stdout. Distinct from `[]`, which means git ran and printed nothing. */
export async function tryRunGitLines(args: string[], cwd: string): Promise<string[] | undefined> {
  const stdout = await tryRunGit(args, cwd);
  return stdout?.split(/\r?\n/).filter(Boolean);
}
