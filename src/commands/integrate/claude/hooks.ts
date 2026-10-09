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

// Claude Code secrets hook detection

import * as nodeFs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';

import type { Console } from '@/core/ui/console.ts';

import { SONAR_SECRETS_MARKER } from '../_common/hooks.ts';

const HOOKS_DIR = 'hooks';
const SETTINGS_FILE = 'settings.json';

const AGENT_CONFIG_DIR: Record<string, string> = {
  claude: '.claude',
};

/**
 * Claude Code's environment variable for project root in case the agent changes cwd durign the run
 */
export const CLAUDE_PROJECT_DIR_PLACEHOLDER = '${CLAUDE_PROJECT_DIR}';

interface HookConfig {
  matcher: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout: number;
  }>;
}

interface AgentSettings {
  hooks?: Record<string, HookConfig[] | undefined>;
  [key: string]: unknown;
}

/**
 * Result of probing for a Sonar secrets hook installation under a given root.
 * Internal — surfaced to callers via {@link detectGlobalSecretsHook} (noisy,
 * for the integrate flow) and {@link areHooksInstalled} (silent probe).
 *
 *  - `installed`: settings entry references sonar-secrets AND the backing
 *    script directory exists. `hookDir` is the absolute path of that directory.
 *  - `orphaned`:  settings entry exists but the backing script directory is
 *    missing — the install was partially deleted/corrupted. `hookDir`
 *    is the expected path of the missing script directory so callers can
 *    surface it to the user.
 *  - `absent`:    no settings entry referencing sonar-secrets.
 */
type SecretsHookState =
  | { kind: 'installed'; hookDir: string }
  | { kind: 'orphaned'; hookDir: string }
  | { kind: 'absent' };

/**
 * Silent probe — single source of truth for the install/orphaned/absent contract.
 */
async function probeSecretsHook(hooksRoot: string): Promise<SecretsHookState> {
  const settingsPath = join(hooksRoot, AGENT_CONFIG_DIR.claude, SETTINGS_FILE);

  if (!nodeFs.existsSync(settingsPath)) {
    return { kind: 'absent' };
  }

  try {
    const data = await fsPromises.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(data) as AgentSettings;

    const hasSettingsEntry = Boolean(
      settings.hooks?.PreToolUse &&
      Array.isArray(settings.hooks.PreToolUse) &&
      settings.hooks.PreToolUse.some(
        (e) =>
          Array.isArray(e.hooks) && e.hooks.some((h) => h.command.includes(SONAR_SECRETS_MARKER)),
      ),
    );

    if (!hasSettingsEntry) {
      return { kind: 'absent' };
    }

    const hookDir = join(hooksRoot, AGENT_CONFIG_DIR.claude, HOOKS_DIR, SONAR_SECRETS_MARKER);
    if (!nodeFs.existsSync(hookDir)) {
      return { kind: 'orphaned', hookDir };
    }
    return { kind: 'installed', hookDir };
  } catch {
    return { kind: 'absent' };
  }
}

/**
 * Probe `hooksRoot` for an existing global sonar-secrets hook. Returns the
 * hook directory when a healthy install is found (caller should skip
 * project-level secrets hooks), and `undefined` otherwise.
 *
 *  - Healthy global install → silent, returns the hook dir.
 *  - Orphaned install → `console.warn(...)` and returns `undefined`.
 *  - No global install → silent, returns `undefined`.
 */
export async function detectGlobalSecretsHook(
  hooksRoot: string,
  console: Console,
): Promise<string | undefined> {
  const state = await probeSecretsHook(hooksRoot);
  if (state.kind === 'installed') {
    return state.hookDir;
  }
  if (state.kind === 'orphaned') {
    console.warn(
      `WARNING: Global hook configuration detected, but the source files are missing at ${state.hookDir}. Falling back to local project installation`,
    );
  }
  return undefined;
}

/**
 * Check whether a Sonar secrets hook is fully installed under `hooksRoot`.
 *
 * Silent — probing must not emit user-facing messages.
 */
export async function areHooksInstalled(hooksRoot: string): Promise<boolean> {
  return (await probeSecretsHook(hooksRoot)).kind === 'installed';
}
