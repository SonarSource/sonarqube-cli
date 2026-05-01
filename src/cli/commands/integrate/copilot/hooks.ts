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

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import { info, success, text, warn } from '../../../../ui';

const SONAR_SECRETS_MARKER = 'sonar-secrets';
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
  hooks: {
    preToolUse?: HookCommandEntry[];
    [eventType: string]: HookCommandEntry[] | undefined;
  };
}

/**
 * Probe `~/.copilot/hooks` for an existing global sonar-secrets pre-tool-use
 * hook and emit a user-facing message describing what was found:
 *
 *  - Healthy global install → `info(...)` and return `true` so the caller
 *    skips the project-level install (avoids double-scanning every file).
 *  - Orphaned install (`hooks.json` references sonar-secrets but the backing
 *    script directory is missing) → `warn(...)` and return `false` so the
 *    caller proceeds with a fresh project-level install.
 *  - No global install → silent, return `false`.
 */
export async function detectGlobalSecretsHook(): Promise<boolean> {
  const hooksJsonPath = join(GLOBAL_HOOKS_DIR, HOOKS_JSON);
  const hookDir = join(GLOBAL_HOOKS_DIR, SCRIPT_REL_DIR);

  if (!existsSync(hooksJsonPath)) return false;

  let parsed: HooksJson;
  try {
    parsed = JSON.parse(await readFile(hooksJsonPath, 'utf-8')) as HooksJson;
  } catch {
    return false;
  }

  const entries = parsed.hooks.preToolUse;
  const referenced = Array.isArray(entries) && entries.some((e) => entryReferencesSonarSecrets(e));
  if (!referenced) return false;

  if (!existsSync(hookDir)) {
    warn(
      `Global hook configuration detected at ${hooksJsonPath} but the backing scripts are missing. Falling back to project-level installation.`,
    );
    return false;
  }

  info(
    `A global secrets scanning hook is already configured at ${hookDir}. Skipping project-level hook to avoid duplicate execution.`,
  );
  return true;
}

/**
 * Write the secrets pre-tool-use script for the current platform and upsert a
 * matching entry in the Copilot `hooks.json`. The hooks directory is derived
 * from `projectRoot` and `isGlobal` so callers don't have to know about it.
 *
 * Emits user-facing progress messages directly.
 */
export async function installPreToolUseHook(projectRoot: string, isGlobal: boolean): Promise<void> {
  text('Installing pre-tool-use secrets hook...');

  const hooksDir = isGlobal ? GLOBAL_HOOKS_DIR : join(projectRoot, PROJECT_HOOKS_REL_DIR);
  const isWindows = process.platform === 'win32';
  const ext = isWindows ? '.ps1' : '.sh';

  const scriptDir = join(hooksDir, SCRIPT_REL_DIR);
  const scriptPath = join(scriptDir, `${SCRIPT_BASENAME}${ext}`);
  mkdirSync(scriptDir, { recursive: true });
  await writeFile(
    scriptPath,
    isWindows ? buildPowershellScript() : buildBashScript(),
    isWindows ? undefined : { mode: 0o755 },
  );

  const hooksJsonPath = join(hooksDir, HOOKS_JSON);
  const hooksJson = await readOrInitHooksJson(hooksJsonPath);

  // Project scope uses paths relative to the hooks dir so the config remains
  // portable when the project is moved or shared via version control.
  // Global scope uses absolute paths because `~/.copilot/hooks` is fixed.
  const commandPath = isGlobal ? scriptPath : relative(hooksDir, scriptPath);

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
}

async function readOrInitHooksJson(path: string): Promise<HooksJson> {
  if (!existsSync(path)) {
    return { version: 1, hooks: {} };
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as HooksJson;
    return {
      version: parsed.version,
      hooks: parsed.hooks,
    };
  } catch {
    return { version: 1, hooks: {} };
  }
}

function entryReferencesSonarSecrets(entry: HookCommandEntry): boolean {
  return Boolean(
    entry.bash?.includes(SONAR_SECRETS_MARKER) || entry.powershell?.includes(SONAR_SECRETS_MARKER),
  );
}

function buildBashScript(): string {
  return `#!/bin/bash
if ! command -v sonar &> /dev/null; then
  exit 0
fi
sonar hook copilot-pre-tool-use
`;
}

function buildPowershellScript(): string {
  return `if (-not (Get-Command sonar -ErrorAction SilentlyContinue)) {
    exit 0
}
$stdinData = [Console]::In.ReadToEnd()
$stdinData | & sonar hook copilot-pre-tool-use
`;
}
