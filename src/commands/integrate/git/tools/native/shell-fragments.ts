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

import { shellQuoteBash } from '@/commands/integrate/_common/hooks.ts';
import type { IntegrationContext } from '@/core/framework/features/types.ts';

import type { GitHookType } from '../../options.ts';
import {
  LEGACY_HOOK_MARKER,
  resolveDepRisksArgs,
  resolveSonarHookCommand,
  SONAR_HOOK_SKIP_SECRETS_MESSAGE,
} from '../shared.ts';

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

function nativeBinBlock(): string {
  return [
    // `|| :` avoids exiting under `sh -e` when `command -v` fails (missing sonar).
    `SONAR_BIN=$(command -v sonar 2>/dev/null || :)`,
    `[ -z "$SONAR_BIN" ] && { echo "${SONAR_HOOK_SKIP_SECRETS_MESSAGE}"; exit 0; }`,
  ].join('\n');
}

/**
 * Chains to a pre-existing local hook that a global `core.hooksPath` override would otherwise
 * silently disable. `git rev-parse --git-dir` always resolves the physical `.git` directory,
 * ignoring any `core.hooksPath` override — unlike `git rev-parse --git-path hooks`, which follows
 * it (verified by hand: https://sonarsource.atlassian.net/browse/CLI-971). The old hook runs
 * first; a non-zero exit aborts immediately with the same code, preserving the abort semantics the
 * repo had before Sonar's hook existed. The marker grep (reusing the same markers `wholeFile`
 * already checks for overwrite/removal) skips chaining when the "pre-existing" hook is actually a
 * Sonar hook from an earlier install, avoiding a double scan.
 */
function nativeChainBlock(hook: GitHookType): string {
  const markerArgs = getRecognizedNativeMarkers(hook)
    .map((marker) => `-e ${shellQuoteBash(marker)}`)
    .join(' ');
  return [
    'SONAR_GIT_DIR=$(git rev-parse --git-dir 2>/dev/null || :)',
    'if [ -n "$SONAR_GIT_DIR" ]; then',
    `  SONAR_LOCAL_HOOK="$SONAR_GIT_DIR/hooks/${hook}"`,
    `  if [ -x "$SONAR_LOCAL_HOOK" ] && ! grep -qF ${markerArgs} "$SONAR_LOCAL_HOOK" 2>/dev/null; then`,
    '    "$SONAR_LOCAL_HOOK" "$@" || exit $?',
    '  fi',
    'fi',
  ].join('\n');
}

/** Returns the hook script. For pre-commit, bakes `--dependency-risks -p <key>` when `context` carries dep-risks attrs. */
export function getHookScript(hook: GitHookType, context: IntegrationContext): string {
  const depRisksArgs = hook === 'pre-commit' ? resolveDepRisksArgs(context) : '';
  return [
    '#!/bin/sh',
    `# ${getNativeHookMarker(hook)}`,
    ...(context.scope === 'global' ? [nativeChainBlock(hook)] : []),
    nativeBinBlock(),
    `"$SONAR_BIN" hook ${resolveSonarHookCommand(hook)}${depRisksArgs}`,
    '',
  ].join('\n');
}
