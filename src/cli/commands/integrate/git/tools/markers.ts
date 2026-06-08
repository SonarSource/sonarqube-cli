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

// Per-hook, framework-scoped markers used to identify Sonar-managed git hooks. Each hook type
// (pre-commit / pre-push) gets a unique marker within a framework. The legacy marker is retained
// only so existing installs are recognized and migrated; it is never emitted for new installs.

import type { GitHookType } from '../options';
import { LEGACY_HOOK_MARKER } from './shared';

// Native (whole-file) ownership comment — a descriptive header, one per hook type.
const NATIVE_HOOK_MARKERS: Record<GitHookType, string> = {
  'pre-commit': 'sonar pre-commit hook - installed by sonar integrate git',
  'pre-push': 'sonar pre-push hook - installed by sonar integrate git',
};

export function getNativeHookMarker(hook: GitHookType): string {
  return NATIVE_HOOK_MARKERS[hook];
}

/** New + legacy markers a native hook of this type may legitimately contain (overwrite guard + detection). */
export function getRecognizedNativeMarkers(hook: GitHookType): string[] {
  return [NATIVE_HOOK_MARKERS[hook], LEGACY_HOOK_MARKER];
}

// Husky (text-snippet) managed-block markers. The end marker is kept verbatim across versions; only
// the start marker changed from the legacy secrets-specific text to this normalized begin marker.
export function getHuskyBeginMarker(hook: GitHookType): string {
  return `# sonar:begin husky-${hook}`;
}

export function getHuskyEndMarker(hook: GitHookType): string {
  return `# sonar:end husky-${hook}`;
}

/** New begin marker + legacy marker used to detect a husky-managed hook of this type. */
export function getRecognizedHuskyMarkers(hook: GitHookType): string[] {
  return [getHuskyBeginMarker(hook), LEGACY_HOOK_MARKER];
}

/** Legacy husky managed-block delimiters, stripped on (re)install/remove to migrate old installs. */
export function legacyHuskyBlock(hook: GitHookType): { startMarker: string; endMarker: string } {
  return { startMarker: `# ${LEGACY_HOOK_MARKER}`, endMarker: getHuskyEndMarker(hook) };
}
