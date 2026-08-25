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
 * `pre-push` delivers the ref list on stdin (`readGitPushRefs()` in `src/commands/hook/stdin.ts`);
 * `pre-commit` reads no stdin at all. A pipe can only be drained once, so once chaining is in play
 * for `pre-push`, both the chained hook and Sonar's own scan need their own read of the same
 * content — confirmed by hand that a naive single read leaves the second reader with nothing,
 * which silently no-ops the scan (`getFileGroupsToScan` treats an empty ref list as "nothing to
 * scan", not an error: `src/commands/hook/git-pre-push.ts`). Captured once into a temp file here,
 * replayed to each reader below.
 */
function stdinCaptureBlock(): string {
  return [
    // A failed mktemp leaves SONAR_STDIN_CACHE empty; `cat >` into that empty path would
    // otherwise fail with a raw, confusing shell error instead of a clear one.
    'SONAR_STDIN_CACHE=$(mktemp) || { echo "sonarqube-cli: mktemp failed, skipping secrets scan"; exit 0; }',
    'trap \'rm -f "$SONAR_STDIN_CACHE"\' EXIT',
    'cat > "$SONAR_STDIN_CACHE"',
  ].join('\n');
}

/**
 * Chains to a pre-existing local hook that a global `core.hooksPath` override would otherwise
 * silently disable. `git rev-parse --git-common-dir` always resolves the physical, *shared* `.git`
 * directory, ignoring any `core.hooksPath` override — unlike `git rev-parse --git-path hooks`,
 * which follows it. `--git-common-dir` (not `--git-dir`) matters specifically for linked worktrees
 * (`git worktree add`): `--git-dir` there resolves to the worktree-private admin directory (e.g.
 * `.git/worktrees/<name>`), which has no `hooks/` of its own — hooks are only ever read from the
 * common dir. In the main worktree `--git-common-dir` and `--git-dir` are the same path, so this is
 * a strict superset, not a behavior change there. The old hook runs first; a non-zero exit aborts
 * immediately with the same code, preserving the abort semantics the repo had before Sonar's hook
 * existed. The marker grep (reusing the same markers `wholeFile` already checks for
 * overwrite/removal) skips chaining when the "pre-existing" hook is actually a Sonar hook from an
 * earlier install, avoiding a double scan.
 *
 * When `stdinFromCache` is set (pre-push only — see `stdinCaptureBlock`), the chained hook reads
 * from the captured copy instead of the hook's own stdin, which was already drained by the capture.
 */
function nativeChainBlock(hook: GitHookType, stdinFromCache: boolean): string {
  const markerArgs = getRecognizedNativeMarkers(hook)
    .map((marker) => `-e ${shellQuoteBash(marker)}`)
    .join(' ');
  const stdinRedirect = stdinFromCache ? ' < "$SONAR_STDIN_CACHE"' : '';
  return [
    'SONAR_GIT_DIR=$(git rev-parse --git-common-dir 2>/dev/null || :)',
    'if [ -n "$SONAR_GIT_DIR" ]; then',
    `  SONAR_LOCAL_HOOK="$SONAR_GIT_DIR/hooks/${hook}"`,
    `  if [ -x "$SONAR_LOCAL_HOOK" ] && ! grep -qF ${markerArgs} "$SONAR_LOCAL_HOOK" 2>/dev/null; then`,
    `    "$SONAR_LOCAL_HOOK" "$@"${stdinRedirect} || exit $?`,
    '  fi',
    'fi',
  ].join('\n');
}

/** Returns the hook script. For pre-commit, bakes `--dependency-risks -p <key>` when `context` carries dep-risks attrs. */
export function getHookScript(hook: GitHookType, context: IntegrationContext): string {
  const depRisksArgs = hook === 'pre-commit' ? resolveDepRisksArgs(context) : '';
  const chains = context.scope === 'global';
  // Only pre-push reads stdin, so only pre-push needs the capture-and-replay dance.
  const needsStdinCapture = chains && hook === 'pre-push';
  return [
    '#!/bin/sh',
    `# ${getNativeHookMarker(hook)}`,
    ...(needsStdinCapture ? [stdinCaptureBlock()] : []),
    ...(chains ? [nativeChainBlock(hook, needsStdinCapture)] : []),
    nativeBinBlock(),
    needsStdinCapture
      ? `"$SONAR_BIN" hook ${resolveSonarHookCommand(hook)}${depRisksArgs} < "$SONAR_STDIN_CACHE"`
      : `"$SONAR_BIN" hook ${resolveSonarHookCommand(hook)}${depRisksArgs}`,
    '',
  ].join('\n');
}
