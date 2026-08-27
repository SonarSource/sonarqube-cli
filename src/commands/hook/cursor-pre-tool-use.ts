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

import { SECRETS_CALLER_COMMANDS } from '@/commands/analyze/secrets-analysis-telemetry.ts';
import type { CommandInvocationContext } from '@/commands/command-invocation-context.ts';
import logger from '@/core/observability/logger.ts';

import { scanAndEmitSecrets } from '../analyze/secrets.ts';
import {
  denyCursor,
  denyCursorFileAccess,
  scanTextForSecrets,
  secretsFoundInScan,
} from './cursor-secrets-block.ts';
import type { HookCommandResult } from './hook-command-result.ts';
import {
  type HookDependencies,
  MissingDependenciesError,
  resolveAuthAndSecrets,
} from './hook-dependencies.ts';
import { readStdinJson } from './stdin.ts';

interface CursorPreToolUsePayload {
  tool_name?: string;
  tool_input?: { file_path?: string; path?: string };
  conversation_id?: string;
}

export async function cursorPreToolUse(ctx: CommandInvocationContext): Promise<HookCommandResult> {
  let payload: CursorPreToolUsePayload;
  try {
    payload = await readStdinJson<CursorPreToolUsePayload>();
  } catch {
    return { agentSessionId: null }; // unparseable stdin — allow
  }

  const agentSessionId = payload.conversation_id ?? null;

  if (payload.tool_name !== 'Read') return { agentSessionId };

  const filePath = payload.tool_input?.file_path ?? payload.tool_input?.path;
  if (!filePath || !existsSync(filePath)) return { agentSessionId };

  let deps: HookDependencies;
  try {
    deps = await resolveAuthAndSecrets();
  } catch (err) {
    if (err instanceof MissingDependenciesError) {
      await denyCursor(err.message);
      return { agentSessionId };
    }
    throw err;
  }

  let scan: Awaited<ReturnType<typeof scanAndEmitSecrets>>;
  try {
    const content = await readFile(filePath, 'utf-8');
    scan = await scanAndEmitSecrets(
      SECRETS_CALLER_COMMANDS.cursorPreToolUse,
      deps.auth,
      () => scanTextForSecrets(deps, content),
      ctx,
    );
  } catch (err) {
    logger.debug(`cursorPreToolUse secrets scan failed: ${(err as Error).message}`);
    return { agentSessionId };
  }

  if (secretsFoundInScan(scan.result)) {
    await denyCursorFileAccess(filePath);
  }

  return { agentSessionId };
}
