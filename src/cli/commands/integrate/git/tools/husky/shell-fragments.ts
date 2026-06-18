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

import type { IntegrationContext } from '../../../_common/registry/types';
import type { GitHookType } from '../../options';
import {
  LEGACY_HOOK_MARKER,
  resolveDepRisksArgs,
  resolveSonarHookCommand,
  SONAR_HOOK_SKIP_SECRETS_MESSAGE,
} from '../shared';

// Husky (text-snippet) managed-block markers. The end marker is kept verbatim across versions; only
// the start marker changed from the legacy secrets-specific text to this normalized begin marker.
export function getHuskyBeginMarker(hook: GitHookType): string {
  return `# sonar:begin husky-${hook}`;
}

/** New begin marker + legacy marker used to detect a husky-managed hook of this type. */
export function getRecognizedHuskyMarkers(hook: GitHookType): string[] {
  return [getHuskyBeginMarker(hook), LEGACY_HOOK_MARKER];
}

function huskyBinBlock(): string {
  return [
    String.raw`CLEAN_PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':' | sed 's/:$//')`,
    String.raw`SONAR_BIN=$(PATH=$CLEAN_PATH command -v sonar 2>/dev/null || :)`,
    `[ -z "$SONAR_BIN" ] && { echo "${SONAR_HOOK_SKIP_SECRETS_MESSAGE}"; exit 0; }`,
  ].join('\n');
}

export function getHuskySnippetContent(hook: GitHookType, context?: IntegrationContext): string {
  const depRisksArgs = hook === 'pre-commit' ? resolveDepRisksArgs(context) : '';
  return [
    huskyBinBlock(),
    `"$SONAR_BIN" hook ${resolveSonarHookCommand(hook)}${depRisksArgs}`,
    '',
  ].join('\n');
}

export function getHuskySnippet(hook: GitHookType): string {
  return ['', getHuskyBeginMarker(hook), getHuskySnippetContent(hook)].join('\n');
}

export function getHuskyPreCommitSnippet(): string {
  return getHuskySnippet('pre-commit');
}

export function getHuskyPrePushSnippet(): string {
  return getHuskySnippet('pre-push');
}
