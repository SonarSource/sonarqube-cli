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

// preToolUse callback handler for Cursor — scans Read tool targets for secrets.
//
// Prefer this hook over beforeReadFile alone: matchers are better documented and beforeReadFile
// has known Cursor bypass paths (e.g. open files in the editor).

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

interface CursorPreToolUsePayload {
  tool_name?: string;
  tool_input?: { file_path?: string; path?: string };
}

export async function cursorPreToolUse(): Promise<void> {
  let payload: CursorPreToolUsePayload;
  try {
    payload = await readStdinJson<CursorPreToolUsePayload>();
  } catch {
    return; // unparseable stdin — allow
  }

  if (payload.tool_name !== 'Read') return;

  const filePath = payload.tool_input?.file_path ?? payload.tool_input?.path;
  if (!filePath || !existsSync(filePath)) return;

  const deps = await resolveAuthAndSecrets();
  if (!deps) return;

  try {
    const content = await readFile(filePath, 'utf-8');
    const result = await scanTextForSecrets(deps, content);
    if (secretsFoundInScan(result)) {
      await denyCursorFileAccess(filePath);
    }
  } catch (err) {
    logger.debug(`cursorPreToolUse secrets scan failed: ${(err as Error).message}`);
  }
}
