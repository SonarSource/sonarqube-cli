/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Standalone shell scripts written to .git/hooks/ (pre-commit or pre-push).
// Pure string factories — no application dependencies.

import type { GitHookType } from '.';

export const HOOK_MARKER = 'Sonar secrets scan - installed by sonar integrate git';

export function getPreCommitHookScript(): string {
  return `#!/bin/sh
# ${HOOK_MARKER}
# Staged files (added/copy/modified, not deleted)
files=$(git diff --cached --name-only --diff-filter=ACMR)
[ -z "$files" ] && exit 0
SONAR_BIN=$(command -v sonar 2>/dev/null)
[ -z "$SONAR_BIN" ] && { echo "sonar not found, skipping secrets scan"; exit 0; }
# One arg per line (handles spaces in filenames)
IFS='
'
set -- $files
exec "$SONAR_BIN" analyze secrets -- "$@"
`;
}

export function getPrePushHookScript(): string {
  return `#!/bin/sh
# ${HOOK_MARKER}
SONAR_BIN=$(command -v sonar 2>/dev/null)
[ -z "$SONAR_BIN" ] && { echo "sonar not found, skipping secrets scan"; exit 0; }
# For each ref being pushed, scan files in the new commits
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "$remote_sha" ] || [ "$remote_sha" = '0000000000000000000000000000000000000000' ] && continue
  [ -z "$local_sha" ] || [ "$local_sha" = '0000000000000000000000000000000000000000' ] && continue
  files=$(git diff --name-only --diff-filter=ACMR "$remote_sha" "$local_sha")
  [ -z "$files" ] && continue
  IFS='
'
  set -- $files
  "$SONAR_BIN" analyze secrets -- "$@" || exit 1
done
exit 0
`;
}

export function getHookScript(hook: GitHookType): string {
  return hook === 'pre-commit' ? getPreCommitHookScript() : getPrePushHookScript();
}
