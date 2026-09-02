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

// Shared deny helpers for Cursor secrets hook handlers.

import { EXIT_CODE_SECRETS_FOUND, runSecretsBinaryOnText } from '../analyze/secrets.ts';
import { appendToCursorIgnore } from './cursor-ignore.ts';
import type { HookDependencies } from './hook-dependencies.ts';

// Cursor treats exit code 2 as a structured block ("equivalent to returning permission: deny"
// per cursor.com/docs/hooks). Other non-zero codes are treated as hook errors and fail open
// (with failClosed: false), so the deny path must exit exactly 2 — not 0. Exiting 2 guarantees
// the block even if Cursor does not parse the JSON, while the JSON still carries the messages.
//
// The beforeSubmitPrompt hook (cursor-prompt-submit.ts) blocks differently — `{ continue: false }`
// at exit 0 — because that event has no `permission` field; the file-read events use this path.
export const CURSOR_BLOCK_EXIT_CODE = 2;
export const SECRETS_IN_FILE_MESSAGE = 'Sonar detected secrets in this file';

export async function scanTextForSecrets(
  deps: HookDependencies,
  content: string,
): ReturnType<typeof runSecretsBinaryOnText> {
  return runSecretsBinaryOnText(deps.binaryPath, content, deps.auth);
}

export function secretsFoundInScan(result: { exitCode: number | null }): boolean {
  return (result.exitCode ?? 1) === EXIT_CODE_SECRETS_FOUND;
}

/**
 * Deny a Cursor file-read/tool-use event with `message`, then exit.
 */
export async function denyCursor(message: string): Promise<never> {
  // process.stdout.write() is buffered and async on pipes; calling process.exit() immediately
  // after can truncate the deny JSON before Cursor reads it. Awaiting the write callback
  // guarantees the payload is fully flushed before the process terminates.
  await new Promise<void>((resolve) => {
    process.stdout.write(
      JSON.stringify({ permission: 'deny', user_message: message, agent_message: message }) + '\n',
      () => {
        resolve();
      },
    );
  });
  process.exit(CURSOR_BLOCK_EXIT_CODE);
}

/** Deny access because secrets were found in `filePath`, adding it to `.cursorignore`. */
export async function denyCursorFileAccess(
  filePath: string | undefined,
  workspaceRoots: string[],
): Promise<never> {
  const ignored = filePath === undefined ? false : appendToCursorIgnore(filePath, workspaceRoots);
  let message: string;
  if (filePath === undefined) {
    message = `${SECRETS_IN_FILE_MESSAGE}.`;
  } else if (ignored) {
    message = `${SECRETS_IN_FILE_MESSAGE}: ${filePath}. File added to .cursorignore — do not attempt alternate read methods.`;
  } else {
    message = `${SECRETS_IN_FILE_MESSAGE}: ${filePath}.`;
  }
  return denyCursor(message);
}
