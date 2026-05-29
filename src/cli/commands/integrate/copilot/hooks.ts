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

import { join } from 'node:path';

import { SONAR_SECRETS_MARKER } from '../_common/hooks';

export const SCRIPT_REL_DIR = join(SONAR_SECRETS_MARKER, 'build-scripts');
export const SCRIPT_BASENAME = 'pretool-secrets';
export const HOOKS_JSON = 'hooks.json';
export const HOOK_TIMEOUT_SEC = 60;

export const PROJECT_HOOKS_REL_DIR = join('.github', 'hooks');

export interface HookCommandEntry {
  type: 'command';
  bash?: string;
  powershell?: string;
  timeoutSec?: number;
}

export interface HooksJson {
  version: number;
  hooks?: {
    // Optional because a user-authored hooks.json may be a bare `{}` with no top-level `hooks` key
    preToolUse?: HookCommandEntry[];
    [eventType: string]: HookCommandEntry[] | undefined;
  };
}

export function entryReferencesSonarSecrets(entry: HookCommandEntry): boolean {
  return Boolean(
    entry.bash?.includes(SONAR_SECRETS_MARKER) || entry.powershell?.includes(SONAR_SECRETS_MARKER),
  );
}

export function hookScriptName(): string {
  return `${SCRIPT_BASENAME}${process.platform === 'win32' ? '.ps1' : '.sh'}`;
}
