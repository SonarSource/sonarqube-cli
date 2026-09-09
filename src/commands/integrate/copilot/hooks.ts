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
import { join, relative } from 'node:path';

import type { IntegrationContext } from '@/core/framework/features';
import type { Console } from '@/core/ui/console.ts';

import { readOrInitJson, SONAR_SECRETS_MARKER } from '../_common/hooks.ts';

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
 *  - Healthy global install → return the script path.
 *  - Orphaned install (`hooks.json` references sonar-secrets but the backing
 *    script is missing) → `console.warn(...)` and return `undefined`.
 *  - No global install → silent, return `undefined`.
 */
export async function detectGlobalSecretsHook(console: Console): Promise<string | undefined> {
  const hooksJsonPath = join(GLOBAL_HOOKS_DIR, HOOKS_JSON);
  if (!existsSync(hooksJsonPath)) return undefined;
  const parsed = await readOrInitJson<HooksJson>(hooksJsonPath, { version: 1, hooks: {} });
  const entries = parsed.hooks?.preToolUse;
  const matchedEntry = Array.isArray(entries)
    ? entries.find((e) => entryReferencesMarker(e, SONAR_SECRETS_MARKER))
    : undefined;
  if (!matchedEntry) return undefined;

  const scriptPath = matchedEntry.bash ?? matchedEntry.powershell;
  if (!scriptPath || !existsSync(scriptPath)) {
    console.warn(
      `Global hook configuration detected at ${hooksJsonPath} but the backing script is missing. Falling back to project-level installation.`,
    );
    return undefined;
  }

  return scriptPath;
}

function entryReferencesMarker(entry: HookCommandEntry, marker: string): boolean {
  return Boolean(entry.bash?.includes(marker) || entry.powershell?.includes(marker));
}

/** Copilot resolves hook commands from the repository root, so project scope uses a relative path. */
export function resolveCopilotHookCommandPath(
  context: IntegrationContext,
  scriptPath: string,
): string {
  return context.scope === 'global' ? scriptPath : relative(context.targetRoot, scriptPath);
}

export function buildCopilotHookEntry(commandPath: string): HookCommandEntry {
  return process.platform === 'win32'
    ? {
        type: 'command',
        timeoutSec: HOOK_TIMEOUT_SEC,
        powershell: commandPath.replaceAll('\\', '/'),
      }
    : { type: 'command', timeoutSec: HOOK_TIMEOUT_SEC, bash: commandPath };
}

/** Idempotent: replaces any existing entries owned by the same marker. */
export function upsertCopilotHooks(
  document: unknown,
  marker: string,
  entries: Record<string, HookCommandEntry>,
): HooksJson {
  const hooksJson = toHooksJson(document);
  hooksJson.hooks ??= {};

  for (const [eventType, entry] of Object.entries(entries)) {
    const existing = hooksJson.hooks[eventType] ?? [];
    hooksJson.hooks[eventType] = [
      ...existing.filter((candidate) => !entryReferencesMarker(candidate, marker)),
      entry,
    ];
  }

  return hooksJson;
}

/** Idempotent inverse of {@link upsertCopilotHooks} for the same markers. */
export function removeCopilotHooks(document: unknown, markers: string[]): HooksJson {
  const hooksJson = toHooksJson(document);
  if (!hooksJson.hooks) {
    return hooksJson;
  }

  const hooks: NonNullable<HooksJson['hooks']> = {};
  for (const [eventType, entries] of Object.entries(hooksJson.hooks)) {
    const filtered = (entries ?? []).filter(
      (entry) => !markers.some((marker) => entryReferencesMarker(entry, marker)),
    );
    if (filtered.length > 0) {
      hooks[eventType] = filtered;
    }
  }

  return { ...hooksJson, hooks };
}

function toHooksJson(document: unknown): HooksJson {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { version: 1, hooks: {} };
  }

  const json = document as Partial<HooksJson>;
  return {
    version: typeof json.version === 'number' ? json.version : 1,
    hooks: json.hooks ? { ...json.hooks } : {},
  };
}

export function hookScriptName(): string {
  return `${SCRIPT_BASENAME}${process.platform === 'win32' ? '.ps1' : '.sh'}`;
}
