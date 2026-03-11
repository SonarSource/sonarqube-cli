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

// All shell script content for git hook integration.
// Pure string factories — no application dependencies.

import type { GitHookType } from '.';

export const HOOK_MARKER = 'Sonar secrets scan - installed by sonar integrate git';

// ─── Shared block ─────────────────────────────────────────────────────────────
// Used inside `while read ... done` in both native and Husky pre-push scripts.
// filesVar: shell variable name to assign results to ('files' in native, 'FILES' in Husky).
// Indented 4 spaces to sit inside `while` + `if [ remote_sha = 0000... ]`.
function newBranchPushBlock(filesVar: string): string {
  return (
    `    # New branch push — enumerate commits not yet on any remote, then diff-tree each one\n` +
    `    EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904\n` +
    `    COMMITS=$(git rev-list "$local_sha" --not --remotes 2>/dev/null)\n` +
    `    if [ -n "$COMMITS" ]; then\n` +
    `      ${filesVar}=$(echo "$COMMITS" | while IFS= read -r c; do\n` +
    `        git diff-tree --no-commit-id -r --name-only --diff-filter=ACMR "$c" 2>/dev/null\n` +
    `      done | sort -u)\n` +
    `    else\n` +
    `      # No other remotes to compare against — diff the full branch against an empty tree\n` +
    `      ${filesVar}=$(git diff --name-only --diff-filter=ACMR $EMPTY_TREE "$local_sha" 2>/dev/null)\n` +
    `    fi`
  );
}

// ─── Native .git/hooks/ scripts ───────────────────────────────────────────────
// Standalone files written to .git/hooks/pre-commit or .git/hooks/pre-push.
// Use plain PATH lookup — git does not inject node_modules/.bin, so no filtering needed.

export function getPreCommitHookScript(): string {
  return `#!/bin/sh
# ${HOOK_MARKER}
# Staged files (added/copy/modified, not deleted)
files=$(git diff --cached --name-only --diff-filter=ACMR)
[ -z "$files" ] && exit 0
SONAR_BIN=$(command -v sonar 2>/dev/null)
[ -z "$SONAR_BIN" ] && { echo "sonarqube-cli not found, skipping secrets scan"; exit 0; }
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
[ -z "$SONAR_BIN" ] && { echo "sonarqube-cli not found, skipping secrets scan"; exit 0; }
# For each ref being pushed, scan files in the new commits
while read -r local_ref local_sha remote_ref remote_sha; do
  # Branch deletion — nothing to scan
  [ "$local_sha" = '0000000000000000000000000000000000000000' ] && continue
  if [ "$remote_sha" = '0000000000000000000000000000000000000000' ]; then
${newBranchPushBlock('files')}
  else
    files=$(git diff --name-only --diff-filter=ACMR "$remote_sha" "$local_sha")
  fi
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

// ─── Husky snippets ───────────────────────────────────────────────────────────
// Fragments appended to existing .husky/pre-commit or .husky/pre-push files.
// Husky prepends node_modules/.bin to PATH, so we strip those entries before
// looking up `sonar` to avoid accidentally running a project-local package.

export function getHuskyPreCommitSnippet(): string {
  return String.raw`
# ${HOOK_MARKER}
FILES=$(git diff --cached --name-only --diff-filter=ACMR)
if [ -n "$FILES" ]; then
  CLEAN_PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':')
  SONAR_BIN=$(PATH=$CLEAN_PATH command -v sonar 2>/dev/null)
  [ -z "$SONAR_BIN" ] && { echo "sonarqube-cli not found, skipping secrets scan"; exit 0; }
  echo "$FILES" | tr '\n' '\0' | xargs -0 "$SONAR_BIN" analyze secrets -- || exit 1
fi
`;
}

export function getHuskyPrePushSnippet(): string {
  return String.raw`
# ${HOOK_MARKER}
while read -r local_ref local_sha remote_ref remote_sha; do
  # Branch deletion — nothing to scan
  [ "$local_sha" = '0000000000000000000000000000000000000000' ] && continue
  if [ "$remote_sha" = '0000000000000000000000000000000000000000' ]; then
${newBranchPushBlock('FILES')}
  else
    FILES=$(git diff --name-only --diff-filter=ACMR "$remote_sha" "$local_sha")
  fi
  if [ -n "$FILES" ]; then
    CLEAN_PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':')
    SONAR_BIN=$(PATH=$CLEAN_PATH command -v sonar 2>/dev/null)
    [ -z "$SONAR_BIN" ] && { echo "sonarqube-cli not found, skipping secrets scan"; exit 0; }
    echo "$FILES" | tr '\n' '\0' | xargs -0 "$SONAR_BIN" analyze secrets -- || exit 1
  fi
done
`;
}

export function getHuskySnippet(hook: GitHookType): string {
  return hook === 'pre-commit' ? getHuskyPreCommitSnippet() : getHuskyPrePushSnippet();
}
