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

// Cursor-specific hook helpers for .cursor/hooks.json.
//
// Cursor uses a flat hook format — each entry is `{ command, matcher, timeout, failClosed }` —
// unlike the nested Claude/Codex format. These helpers are isolated here and do not modify
// the shared hook infrastructure.

import {
  HOOK_TIMEOUT_SEC,
  resolveAgentHookCommand,
  SONAR_SECRETS_MARKER,
} from '../_common/hooks.ts';
import type { IntegrationContext } from '../_common/registry';

export const CURSOR_HOOK_MATCHERS: Record<string, string> = {
  beforeReadFile: 'Read|TabRead',
  beforeSubmitPrompt: 'UserPromptSubmit',
  preToolUse: 'Read',
};

export function resolveCursorHookMatcher(eventType: string): string {
  return CURSOR_HOOK_MATCHERS[eventType] ?? '.*';
}

export interface CursorFlatHookEntry {
  command: string;
  matcher: string;
  timeout: number;
  failClosed: boolean;
}

export interface CursorHooksDocument {
  version: 1;
  hooks: Record<string, CursorFlatHookEntry[]>;
  [key: string]: unknown;
}

export interface ManagedCursorHookEntry {
  eventType: string;
  marker: string;
  entry: CursorFlatHookEntry;
}

/** Build a managed Cursor hook entry for a given event and script. */
export function buildCursorHookEntry(
  context: IntegrationContext,
  configDir: string,
  eventType: string,
  scriptPath: string,
  failClosed = false,
): ManagedCursorHookEntry {
  return {
    eventType,
    marker: SONAR_SECRETS_MARKER,
    entry: {
      command: resolveAgentHookCommand(context, configDir, scriptPath),
      matcher: resolveCursorHookMatcher(eventType),
      timeout: HOOK_TIMEOUT_SEC,
      failClosed,
    },
  };
}

/**
 * Idempotent upsert: for each managed entry, drop any existing entries whose
 * command contains the marker, then append the desired entry.
 */
export function upsertCursorHooks(
  document: unknown,
  entries: ManagedCursorHookEntry[],
): CursorHooksDocument {
  const hooksDoc = toCursorHooksDocument(document);

  for (const { eventType, marker, entry } of entries) {
    const existing = Array.isArray(hooksDoc.hooks[eventType]) ? hooksDoc.hooks[eventType] : [];
    hooksDoc.hooks[eventType] = [...existing.filter((e) => !ownsCursorHookEntry(e, marker)), entry];
  }

  return hooksDoc;
}

/**
 * Remove hook entries whose command contains any of the given markers.
 * Idempotent inverse of {@link upsertCursorHooks} for the same markers.
 */
export function removeCursorHooks(document: unknown, markers: string[]): CursorHooksDocument {
  const hooksDoc = toCursorHooksDocument(document);
  const hooks: Record<string, CursorFlatHookEntry[]> = {};

  for (const [eventType, entries] of Object.entries(hooksDoc.hooks)) {
    const list = Array.isArray(entries) ? entries : [];
    const filtered = list.filter((e) => !markers.some((m) => ownsCursorHookEntry(e, m)));
    if (filtered.length > 0) {
      hooks[eventType] = filtered;
    }
  }

  return { ...hooksDoc, hooks };
}

function ownsCursorHookEntry(
  entry: CursorFlatHookEntry | null | undefined,
  marker: string,
): boolean {
  return typeof entry?.command === 'string' && entry.command.includes(marker);
}

function toCursorHooksDocument(document: unknown): CursorHooksDocument {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { version: 1, hooks: {} };
  }

  const doc = document as Partial<CursorHooksDocument>;
  return {
    ...doc,
    version: doc.version ?? 1,
    hooks:
      doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks)
        ? { ...doc.hooks }
        : {},
  };
}
