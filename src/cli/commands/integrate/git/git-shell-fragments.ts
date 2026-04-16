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

// ─── Binary resolution blocks ──────────────────────────────────────────────────
// The only material difference between native and Husky variants.
// Husky injects node_modules/.bin into PATH — strip it before looking up sonar.

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

// ─── Native .git/hooks/ scripts ───────────────────────────────────────────────
// Standalone files written to .git/hooks/pre-commit or .git/hooks/pre-push.
// Use plain PATH lookup — git does not inject node_modules/.bin.

export function getPreCommitHookScript(): string {
  return `#!/bin/sh\n# ${HOOK_MARKER}\n${nativeBinBlock()}\n"$SONAR_BIN" hook git-pre-commit\n`;
}

export function getPrePushHookScript(): string {
  return `#!/bin/sh\n# ${HOOK_MARKER}\n${nativeBinBlock()}\n"$SONAR_BIN" hook git-pre-push\n`;
}

export function getHookScript(hook: GitHookType): string {
  return hook === 'pre-commit' ? getPreCommitHookScript() : getPrePushHookScript();
}

// ─── Husky snippets ───────────────────────────────────────────────────────────
// Fragments appended to existing .husky/pre-commit or .husky/pre-push files.
// Husky prepends node_modules/.bin to PATH, so we strip those entries before
// looking up `sonar` to avoid accidentally running a project-local package.

export function getHuskyPreCommitSnippet(): string {
  return `\n# ${HOOK_MARKER}\n${huskyBinBlock()}\n"$SONAR_BIN" hook git-pre-commit\n`;
}

export function getHuskyPrePushSnippet(): string {
  return `\n# ${HOOK_MARKER}\n${huskyBinBlock()}\n"$SONAR_BIN" hook git-pre-push\n`;
}

export function getHuskySnippet(hook: GitHookType): string {
  return hook === 'pre-commit' ? getHuskyPreCommitSnippet() : getHuskyPrePushSnippet();
}
