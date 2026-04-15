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

export function git(args: string[], cwd: string): string {
  return execFileSync(GIT_BIN, args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
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
