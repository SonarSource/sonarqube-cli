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

import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { EXIT_CODE_SECRETS_FOUND } from '@/core/config-constants.ts';

import {
  runSecretsBinaryOnStream,
  runSecretsBinaryOnText,
  SCAN_TIMEOUT_MS,
} from '../analyze/secrets.ts';
import { appendToCursorIgnore, workspaceRootToPath } from './cursor-ignore.ts';
import type { HookDependencies } from './hook-dependencies.ts';

// Cursor treats exit code 2 as a structured block ("equivalent to returning permission: deny"
// per cursor.com/docs/hooks). Other non-zero codes are treated as hook errors and fail open
// (with failClosed: false), so the deny path must exit exactly 2 — not 0. Exiting 2 guarantees
// the block even if Cursor does not parse the JSON, while the JSON still carries the messages.
//
// The beforeSubmitPrompt hook (cursor-prompt-submit.ts) blocks differently — `{ continue: false }`
// at exit 0 — because that event has no `permission` field; the file-read events use this path.
export const CURSOR_BLOCK_EXIT_CODE = 2;
export const SECRETS_IN_FILE_MESSAGE = 'SonarQube detected secrets in this file';

export async function scanTextForSecrets(
  deps: HookDependencies,
  content: string,
  filePath?: string,
  workspaceRoots: string[] = [],
): ReturnType<typeof runSecretsBinaryOnText> {
  if (!filePath) return runSecretsBinaryOnText(deps.binaryPath, content, deps.auth);

  const absolutePath = resolve(filePath);
  const relativePaths = workspaceRoots
    .filter(Boolean)
    .map((root) => relative(workspaceRootToPath(root), absolutePath))
    .filter((path) => path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  relativePaths.sort((a, b) => a.length - b.length);
  const path = (relativePaths[0] ?? filePath).replaceAll('\\', '/');
  // Batch headers cannot encode newlines; text mode still scans these files.
  if (path.includes('\n') || path.includes('\r')) {
    return runSecretsBinaryOnText(deps.binaryPath, content, deps.auth);
  }

  const bytes = Buffer.from(content, 'utf-8');
  const batch = Readable.from([
    Buffer.from(`scan cursor\n${bytes.length} ${path}\n`, 'utf-8'),
    bytes,
    Buffer.from('\n'),
  ]);
  return runSecretsBinaryOnStream(deps.binaryPath, batch, deps.auth, SCAN_TIMEOUT_MS);
}

export function secretsFoundInScan(result: { exitCode: number | null }): boolean {
  return (result.exitCode ?? 1) === EXIT_CODE_SECRETS_FOUND;
}

export async function denyCursor(message: string): Promise<never> {
  // process.stdout.write() is buffered and async on pipes, so the process can end before Cursor
  // reads the deny JSON. Awaiting the write callback guarantees the payload is fully flushed
  // before the command reports the required exit code.
  await new Promise<void>((resolve) => {
    process.stdout.write(
      JSON.stringify({ permission: 'deny', user_message: message, agent_message: message }) + '\n',
      () => {
        resolve();
      },
    );
  });
  throw new CommandFailedError('Cursor blocked file access.', {
    exitCode: CURSOR_BLOCK_EXIT_CODE,
  });
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
