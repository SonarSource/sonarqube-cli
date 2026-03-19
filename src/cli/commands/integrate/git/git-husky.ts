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

// Husky integration: appends a secrets-scan snippet to an existing .husky hook file.

import { info, success } from '../../../../ui';
import { HOOK_MARKER, getHuskySnippet } from './git-shell-fragments';
import type { GitHookType } from '.';
import { readFile, writeFile } from 'node:fs/promises';

export async function installViaHusky(huskyHookPath: string, hook: GitHookType): Promise<void> {
  let content: string;
  try {
    content = await readFile(huskyHookPath, 'utf-8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      content = '';
    } else {
      throw error;
    }
  }
  if (content.includes(HOOK_MARKER)) {
    info(`Secrets check already present in .husky/${hook}.`);
    return;
  }
  const newContent = content ? content.trimEnd() + getHuskySnippet(hook) : getHuskySnippet(hook);
  await writeFile(huskyHookPath, newContent, { encoding: 'utf-8', mode: 0o755 });
  success(`${hook} hook installed (Husky detected: added to .husky/${hook}).`);
}
