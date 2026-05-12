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

import { existsSync, mkdirSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { success, text, warn } from '../../../../../../ui';
import { CommandFailedError } from '../../../../_common/error';
import type { GitHookType } from '../../options';
import { HOOK_MARKER } from '../shared';
import { getHookScript } from './shell-fragments';

const OVERWRITE_HOOK_REMEDIATION_HINT = 'Use --force to replace the existing hook.';

export async function writeManagedGitHook(
  hookPath: string,
  hook: GitHookType,
  force?: boolean,
): Promise<void> {
  mkdirSync(dirname(hookPath), { recursive: true });
  if (existsSync(hookPath)) {
    const existing = await fs.readFile(hookPath, 'utf-8');
    if (!existing.includes(HOOK_MARKER) && !force) {
      warn(`A different ${hook} hook already exists at ${hookPath}.`);
      text('  Use --force to replace it.');
      throw new CommandFailedError(`Refusing to overwrite existing ${hook} hook at ${hookPath}.`, {
        remediationHint: OVERWRITE_HOOK_REMEDIATION_HINT,
      });
    }
  }
  await fs.writeFile(hookPath, getHookScript(hook), { mode: 0o755 });
}

export async function installViaGitHooks(
  hooksDir: string,
  hook: GitHookType,
  force?: boolean,
): Promise<void> {
  const hookPath = join(hooksDir, hook);
  await writeManagedGitHook(hookPath, hook, force);
  success(`${hook} hook installed at ${hookPath}`);
}
