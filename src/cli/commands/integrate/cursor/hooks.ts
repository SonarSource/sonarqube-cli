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

// Cursor-specific hooks.json helpers.
//
// Cursor's hook config diverges from the shared `{ hooks: { <event>: HookConfig[] } }` shape used
// by Claude and Codex (see `_common/hooks.ts`): it wraps the map in a `{ version, hooks }` document
// and each event entry is a flat `{ command }` object rather than a `{ matcher, hooks: [...] }`
// nesting. Ownership of an entry is identified by the marker embedded in its command path.
// See https://cursor.com/docs/agent/hooks.

const DEFAULT_CURSOR_HOOKS_VERSION = 1;

export interface CursorHookEntry {
  command: string;
  timeout?: number;
}

export interface CursorHooksDocument {
  version?: number;
  hooks?: Record<string, CursorHookEntry[]>;
  [key: string]: unknown;
}

function toCursorHooksDocument(document: unknown): CursorHooksDocument {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { version: DEFAULT_CURSOR_HOOKS_VERSION, hooks: {} };
  }

  const settings = document as CursorHooksDocument;
  return {
    ...settings,
    version: settings.version ?? DEFAULT_CURSOR_HOOKS_VERSION,
    hooks: settings.hooks ? { ...settings.hooks } : {},
  };
}

// `entry` is typed as a well-formed CursorHookEntry, but the array is parsed from a user-editable
// hooks.json and may contain hand-written or third-party junk (missing/non-string command, or even
// a non-object element), so widen the type and guard before calling String.includes.
function ownsCursorHookEntry(entry: CursorHookEntry | null | undefined, marker: string): boolean {
  return typeof entry?.command === 'string' && entry.command.includes(marker);
}

/**
 * Idempotent upsert: drop any existing entry for `eventType` owned by `marker` (its command
 * contains the marker) and append the desired `{ command }` entry. Returns a new document; does
 * not mutate the input.
 */
export function upsertCursorHook(
  document: unknown,
  eventType: string,
  command: string,
  marker: string,
): CursorHooksDocument {
  const settings = toCursorHooksDocument(document);
  settings.hooks ??= {};

  // The event value comes from a user-editable hooks.json and may not be an array
  // (e.g. hand-edited to an object or string); treat any non-array as empty.
  const raw = settings.hooks[eventType];
  const existing = Array.isArray(raw) ? raw : [];
  settings.hooks[eventType] = [
    ...existing.filter((entry) => !ownsCursorHookEntry(entry, marker)),
    { command },
  ];

  return settings;
}

/**
 * Remove every hook entry whose command contains `marker`, dropping now-empty event arrays.
 * Idempotent inverse of {@link upsertCursorHook} for the same marker.
 */
export function removeCursorHook(document: unknown, marker: string): CursorHooksDocument {
  const settings = toCursorHooksDocument(document);
  if (!settings.hooks) {
    return settings;
  }

  const hooks: Record<string, CursorHookEntry[]> = {};
  for (const [eventType, entries] of Object.entries(settings.hooks)) {
    // Tolerate non-array event values from a hand-edited hooks.json (treat as empty).
    const list = Array.isArray(entries) ? entries : [];
    const filtered = list.filter((entry) => !ownsCursorHookEntry(entry, marker));
    if (filtered.length > 0) {
      hooks[eventType] = filtered;
    }
  }

  return { ...settings, hooks };
}
