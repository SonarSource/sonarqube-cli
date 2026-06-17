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

// beforeReadFile callback handler for Cursor — scans files for secrets before the agent reads them.
//
// Cursor's stdin payload uses `file_path` and includes `content` (see cursor.com/docs/hooks).
// Also register preToolUse (Read) — beforeReadFile is bypassed when files are open in the editor.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import logger from '../../../lib/logger';
import {
  denyCursorFileAccess,
  scanTextForSecrets,
  secretsFoundInScan,
} from './cursor-secrets-block';
import { resolveAuthAndSecrets } from './hook-dependencies';
import { readStdinJson } from './stdin';

interface CursorBeforeReadFilePayload {
  file_path?: string;
  content?: string;
}

export async function cursorPreFileRead(): Promise<void> {
  let payload: CursorBeforeReadFilePayload;
  try {
    payload = await readStdinJson<CursorBeforeReadFilePayload>();
  } catch {
    return; // unparseable stdin — allow
  }

  const filePath = payload.file_path;
  const content = await resolveFileContent(payload, filePath);
  if (content === undefined) return;

  const deps = await resolveAuthAndSecrets();
  if (!deps) return;

  try {
    const result = await scanTextForSecrets(deps, content);
    if (secretsFoundInScan(result)) {
      denyCursorFileAccess(filePath);
    }
  } catch (err) {
    logger.debug(`cursorPreFileRead secrets scan failed: ${(err as Error).message}`);
  }
}

async function resolveFileContent(
  payload: CursorBeforeReadFilePayload,
  filePath: string | undefined,
): Promise<string | undefined> {
  if (payload.content !== undefined) {
    return payload.content;
  }

  if (!filePath || !existsSync(filePath)) return undefined;

  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    logger.debug(`cursorPreFileRead failed to read file: ${(err as Error).message}`);
    return undefined;
  }
}
