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

// Husky integration: snippets appended to existing .husky/pre-commit or .husky/pre-push files.

import { info, success } from '../../../../ui';
import { HOOK_MARKER } from './git-scripts';
import type { GitHookType } from '.';

function getHuskyPreCommitSnippet(): string {
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

function getHuskyPrePushSnippet(): string {
  return String.raw`
# ${HOOK_MARKER}
while read -r local_ref local_sha remote_ref remote_sha; do
  # Branch deletion — nothing to scan
  [ "$local_sha" = '0000000000000000000000000000000000000000' ] && continue
  if [ "$remote_sha" = '0000000000000000000000000000000000000000' ]; then
    # New branch push — enumerate commits not yet on any remote, then diff-tree each one
    EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904
    COMMITS=$(git rev-list "$local_sha" --not --remotes 2>/dev/null)
    if [ -n "$COMMITS" ]; then
      FILES=$(echo "$COMMITS" | while IFS= read -r c; do
        git diff-tree --no-commit-id -r --name-only --diff-filter=ACMR "$c" 2>/dev/null
      done | sort -u)
    else
      # No other remotes to compare against — diff the full branch against an empty tree
      FILES=$(git diff --name-only --diff-filter=ACMR $EMPTY_TREE "$local_sha" 2>/dev/null)
    fi
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

function getHuskySnippet(hook: GitHookType): string {
  return hook === 'pre-commit' ? getHuskyPreCommitSnippet() : getHuskyPrePushSnippet();
}

export async function installViaHusky(huskyHookPath: string, hook: GitHookType): Promise<void> {
  const fs = await import('node:fs/promises');
  const content = await fs.readFile(huskyHookPath, 'utf-8');
  if (content.includes(HOOK_MARKER)) {
    info(`Secrets check already present in .husky/${hook}.`);
    return;
  }
  await fs.writeFile(huskyHookPath, content.trimEnd() + getHuskySnippet(hook), 'utf-8');
  success(`${hook} hook installed (Husky detected: added to .husky/${hook}).`);
}
