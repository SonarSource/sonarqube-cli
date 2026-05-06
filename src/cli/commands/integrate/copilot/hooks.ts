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

// Copilot CLI hook installation.
// Writes a single OS-specific script and registers it in
// the Copilot `hooks.json` config.

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import { info, success, text, warn } from '../../../../ui';
import { installSecretsBinary } from '../../_common/install/secrets';
import { readOrInitJson, SONAR_SECRETS_MARKER, writeHookScript } from '../_common/hooks';
import { getSecretPreToolTemplateUnix, getSecretPreToolTemplateWindows } from './hook-templates';

export interface HookInstallResult {
  /* Absolute path of the active sonar-secrets hook script. `undefined` when installation failed. */
  hookPath?: string;
  hookInstalled: boolean;
}

const SCRIPT_REL_DIR = join(SONAR_SECRETS_MARKER, 'build-scripts');
const SCRIPT_BASENAME = 'pretool-secrets';
const HOOKS_JSON = 'hooks.json';
const HOOK_TIMEOUT_SEC = 60;

const PROJECT_HOOKS_REL_DIR = join('.github', 'hooks');
const GLOBAL_HOOKS_DIR = join(homedir(), '.copilot', 'hooks');

interface HookCommandEntry {
  type: 'command';
  bash?: string;
  powershell?: string;
  timeoutSec?: number;
}

interface HooksJson {
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
async function detectGlobalSecretsHook(): Promise<string | undefined> {
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

/**
 * Write the secrets pre-tool-use script for the current platform and upsert a
 * matching entry in the Copilot `hooks.json`. The hooks directory is derived
 * from `projectRoot` and `isGlobal` so callers don't have to know about it.
 *
 * Emits user-facing progress messages directly.
 */
async function installPreToolUseHook(projectRoot: string, isGlobal: boolean): Promise<string> {
  text('Installing pre-tool-use secrets hook...');

  const hooksDir = isGlobal ? GLOBAL_HOOKS_DIR : join(projectRoot, PROJECT_HOOKS_REL_DIR);
  const isWindows = process.platform === 'win32';

  const scriptDir = join(hooksDir, SCRIPT_REL_DIR);
  const scriptPath = await writeHookScript(
    scriptDir,
    SCRIPT_BASENAME,
    getSecretPreToolTemplateUnix(),
    getSecretPreToolTemplateWindows(),
  );

  const hooksJsonPath = join(hooksDir, HOOKS_JSON);
  const hooksJson = await readOrInitJson<HooksJson>(hooksJsonPath, { version: 1, hooks: {} });
  hooksJson.hooks ??= {};

  // Project scope uses paths relative to the project root so the config remains
  // portable when the project is moved or shared via version control. Copilot
  // CLI resolves relative `powershell`/`bash` entries against the session's
  // working directory (the project root), not the hooks dir, so paths relative
  // to the hooks dir silently fail to find the script on Windows.
  // Global scope uses absolute paths because `~/.copilot/hooks` is fixed.
  const commandPath = isGlobal ? scriptPath : relative(projectRoot, scriptPath);

  const newEntry: HookCommandEntry = {
    type: 'command',
    timeoutSec: HOOK_TIMEOUT_SEC,
  };
  if (isWindows) {
    // Normalize Windows backslashes so the JSON entry stays clean and matches
    // the convention used by the Claude integration.
    newEntry.powershell = commandPath.replaceAll('\\', '/');
  } else {
    newEntry.bash = commandPath;
  }

  const existing = hooksJson.hooks.preToolUse ?? [];
  hooksJson.hooks.preToolUse = [
    ...existing.filter((e) => !entryReferencesSonarSecrets(e)),
    newEntry,
  ];

  await writeFile(hooksJsonPath, JSON.stringify(hooksJson, null, 2) + '\n', 'utf-8');

  success(`Pre-tool-use hook installed (${hooksJsonPath})`);
  return scriptPath;
}

export async function installHooks(
  projectRoot: string,
  isGlobal: boolean,
): Promise<HookInstallResult> {
  try {
    await installSecretsBinary();
    if (!isGlobal) {
      const existingGlobalHookPath = await detectGlobalSecretsHook();
      if (existingGlobalHookPath) {
        return { hookPath: existingGlobalHookPath, hookInstalled: false };
      }
    }
    const hookPath = await installPreToolUseHook(projectRoot, isGlobal);
    return { hookPath, hookInstalled: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warn(
      `Failed to set up the pre-tool-use secrets hook: ${detail}. Secrets scanning will not run.`,
    );
    return { hookInstalled: false };
  }
}

function entryReferencesSonarSecrets(entry: HookCommandEntry): boolean {
  return Boolean(
    entry.bash?.includes(SONAR_SECRETS_MARKER) || entry.powershell?.includes(SONAR_SECRETS_MARKER),
  );
}
