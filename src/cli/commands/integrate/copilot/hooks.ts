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

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { info, warn } from '../../../../ui';
import { readOrInitJson, SONAR_SECRETS_MARKER } from '../_common/hooks';

export const SCRIPT_REL_DIR = join(SONAR_SECRETS_MARKER, 'build-scripts');
export const SCRIPT_BASENAME = 'pretool-secrets';
export const HOOKS_JSON = 'hooks.json';
export const HOOK_TIMEOUT_SEC = 60;

export const PROJECT_HOOKS_REL_DIR = join('.github', 'hooks');
export const GLOBAL_HOOKS_DIR = join(homedir(), '.copilot', 'hooks');

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

/**
 * Probe `~/.copilot/hooks` for an existing global sonar-secrets pre-tool-use
 * hook. Returns the path of the active hook script when a healthy global
 * install is found (caller should skip project-level install to avoid
 * double-scanning), and `undefined` otherwise.
 *
 *  - Healthy global install → `info(...)` and return the script path.
 *  - Orphaned install (`hooks.json` references sonar-secrets but the backing
 *    script is missing) → `warn(...)` and return `undefined`.
 *  - No global install → silent, return `undefined`.
 */
export async function detectGlobalSecretsHook(): Promise<string | undefined> {
  const hooksJsonPath = join(GLOBAL_HOOKS_DIR, HOOKS_JSON);
  if (!existsSync(hooksJsonPath)) return undefined;
  const parsed = await readOrInitJson<HooksJson>(hooksJsonPath, { version: 1, hooks: {} });
  const entries = parsed.hooks?.preToolUse;
  const matchedEntry = Array.isArray(entries)
    ? entries.find((e) => entryReferencesSonarSecrets(e))
    : undefined;
  if (!matchedEntry) return undefined;

  const scriptPath = matchedEntry.bash ?? matchedEntry.powershell;
  if (!scriptPath || !existsSync(scriptPath)) {
    warn(
      `Global hook configuration detected at ${hooksJsonPath} but the backing script is missing. Falling back to project-level installation.`,
    );
    return undefined;
  }

  info(
    `A global secrets scanning hook is already configured at ${scriptPath}. Skipping project-level hook to avoid duplicate execution.`,
  );
  return scriptPath;
}

export function entryReferencesSonarSecrets(entry: HookCommandEntry): boolean {
  return Boolean(
    entry.bash?.includes(SONAR_SECRETS_MARKER) || entry.powershell?.includes(SONAR_SECRETS_MARKER),
  );
}

export function hookScriptName(): string {
  return `${SCRIPT_BASENAME}${process.platform === 'win32' ? '.ps1' : '.sh'}`;
}
