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

export async function installViaHusky(huskyHookPath: string, hook: GitHookType): Promise<void> {
  const fs = await import('node:fs/promises');
  const content = await fs.readFile(huskyHookPath, 'utf-8');
  if (content.includes(HOOK_MARKER)) {
    info(`Secrets check already present in .husky/${hook}.`);
    return;
  }
  await fs.writeFile(huskyHookPath, content.trimEnd() + getHuskySnippet(hook), 'utf-8');
  success(`${hook} hook installed (Husky detected: added to .husky/${hook}).`);
}
