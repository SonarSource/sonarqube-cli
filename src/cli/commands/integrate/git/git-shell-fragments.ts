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

// All shell script content for git hook integration.
// Pure string factories — no application dependencies.

import type { GitHookType } from '.';

export const HOOK_MARKER = 'Sonar secrets scan - installed by sonar integrate git';

export const SONAR_HOOK_SKIP_SECRETS_MESSAGE = 'sonarqube-cli not found, skipping secrets scan';

/**
 * All-zero object id Git passes on pre-push stdin for ref deletion (`local_sha`) and new refs
 * (`remote_sha`). See githooks(5) "pre-push". SHA-1 length; SHA-256 repos use 64 hex zeros instead.
 */
const GIT_HOOK_NULL_OID = '0000000000000000000000000000000000000000';

// ─── Shared block ─────────────────────────────────────────────────────────────
// Used inside `while read ... done` in both native and Husky pre-push scripts.
// filesVar: shell variable name to assign results to.
// Indented 4 spaces to sit inside `while` + `if [ remote_sha = null oid ]`.
// `$EMPTY_TREE` is set once before the loop (see prePushBody).
function newBranchPushBlock(filesVar: string): string {
  return (
    `    # New branch push — enumerate commits not yet on any remote, then diff-tree each one\n` +
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

// ─── Binary resolution blocks ──────────────────────────────────────────────────
// The only material difference between native and Husky variants.
// Husky injects node_modules/.bin into PATH — strip it before looking up sonar.

type BinBlock = () => string;

function nativeBinBlock(): string {
  return (
    // `|| :` avoids exiting under `sh -e` when `command -v` fails (missing sonar).
    `SONAR_BIN=$(command -v sonar 2>/dev/null || :)\n` +
    `[ -z "$SONAR_BIN" ] && { echo "${SONAR_HOOK_SKIP_SECRETS_MESSAGE}"; exit 0; }`
  );
}

function huskyBinBlock(): string {
  return (
    `CLEAN_PATH=$(echo "$PATH" | tr ':' '\\n' | grep -v node_modules | tr '\\n' ':' | sed 's/:$//')\n` +
    `SONAR_BIN=$(PATH=$CLEAN_PATH command -v sonar 2>/dev/null || :)\n` +
    `[ -z "$SONAR_BIN" ] && { echo "${SONAR_HOOK_SKIP_SECRETS_MESSAGE}"; exit 0; }`
  );
}

// ─── Shared script templates ───────────────────────────────────────────────────
// Accept a binBlock function (native or Husky) to produce the correct resolver.

function preCommitBody(filesVar: string, binBlock: BinBlock): string {
  return (
    `${filesVar}=$(git diff --cached --name-only --diff-filter=ACMR)\n` +
    `[ -z "$${filesVar}" ] && exit 0\n` +
    `${binBlock()}\n` +
    `echo "$${filesVar}" | tr '\\n' '\\0' | xargs -0 "$SONAR_BIN" analyze secrets -- || exit 1\n`
  );
}

function prePushBody(filesVar: string, binBlock: BinBlock): string {
  return (
    `${binBlock()}\n` +
    `# Canonical empty tree: \`git mktree\` with no entries (correct for the repo's hash algorithm).\n` +
    `EMPTY_TREE=$(printf '' | git mktree)\n` +
    `# For each ref being pushed, scan files in the new commits\n` +
    `while read -r local_ref local_sha remote_ref remote_sha; do\n` +
    `  # Branch deletion — nothing to scan\n` +
    `  [ "$local_sha" = '${GIT_HOOK_NULL_OID}' ] && continue\n` +
    `  if [ "$remote_sha" = '${GIT_HOOK_NULL_OID}' ]; then\n` +
    `${newBranchPushBlock(filesVar)}\n` +
    `  else\n` +
    `    ${filesVar}=$(git diff --name-only --diff-filter=ACMR "$remote_sha" "$local_sha")\n` +
    `  fi\n` +
    `  [ -z "$${filesVar}" ] && continue\n` +
    `  echo "$${filesVar}" | tr '\\n' '\\0' | xargs -0 "$SONAR_BIN" analyze secrets -- || exit 1\n` +
    `done\n` +
    `exit 0\n`
  );
}

// ─── Native .git/hooks/ scripts ───────────────────────────────────────────────
// Standalone files written to .git/hooks/pre-commit or .git/hooks/pre-push.
// Use plain PATH lookup — git does not inject node_modules/.bin.

export function getPreCommitHookScript(): string {
  return (
    `#!/bin/sh\n` +
    `# ${HOOK_MARKER}\n` +
    `# Staged files (added/copy/modified, not deleted)\n` +
    preCommitBody('FILES', nativeBinBlock)
  );
}

export function getPrePushHookScript(): string {
  return `#!/bin/sh\n# ${HOOK_MARKER}\n` + prePushBody('FILES', nativeBinBlock);
}

export function getHookScript(hook: GitHookType): string {
  return hook === 'pre-commit' ? getPreCommitHookScript() : getPrePushHookScript();
}

// ─── Husky snippets ───────────────────────────────────────────────────────────
// Fragments appended to existing .husky/pre-commit or .husky/pre-push files.
// Husky prepends node_modules/.bin to PATH, so we strip those entries before
// looking up `sonar` to avoid accidentally running a project-local package.

export function getHuskyPreCommitSnippet(): string {
  return `\n# ${HOOK_MARKER}\n` + preCommitBody('FILES', huskyBinBlock);
}

export function getHuskyPrePushSnippet(): string {
  return `\n# ${HOOK_MARKER}\n` + prePushBody('FILES', huskyBinBlock);
}

export function getHuskySnippet(hook: GitHookType): string {
  return hook === 'pre-commit' ? getHuskyPreCommitSnippet() : getHuskyPrePushSnippet();
}
