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

// PreToolUse handler for Devin — scans the file Devin's `read` tool is about to open for secrets.

import { existsSync } from 'node:fs';

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { EXIT_CODE_SECRETS_FOUND, SECRETS_CALLER_COMMANDS } from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';

import type { HookCommandResult } from './hook-command-result.ts';
import {
  type HookDependencies,
  MissingDependenciesError,
  resolveAuthAndSecrets,
  runAndEmitFileSecretsScan,
} from './hook-dependencies.ts';
import { readStdinJson } from './stdin.ts';

interface PreToolUsePayload {
  tool_name?: string;
  tool_input?: { file_path?: string };
  session_id?: string;
}

function denyToolUse(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }) + '\n',
  );
}

export async function devinPreToolUse(ctx: CommandInvocationContext): Promise<HookCommandResult> {
  let payload: PreToolUsePayload;
  try {
    payload = await readStdinJson<PreToolUsePayload>();
  } catch {
    return { agentSessionId: null }; // unparseable stdin — allow
  }

  const agentSessionId = payload.session_id ?? null;

  // Devin tool names are lowercase and hook matching is case-sensitive.
  if (payload.tool_name !== 'read') return { agentSessionId };

  const filePath = payload.tool_input?.file_path;
  if (!filePath || !existsSync(filePath)) return { agentSessionId };

  let deps: HookDependencies;
  try {
    deps = await resolveAuthAndSecrets(ctx);
  } catch (err) {
    if (err instanceof MissingDependenciesError) {
      denyToolUse(err.message);
      return { agentSessionId };
    }
    throw err;
  }

  try {
    const exitCode = await runAndEmitFileSecretsScan(
      SECRETS_CALLER_COMMANDS.devinPreToolUse,
      deps,
      filePath,
      ctx,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      denyToolUse(`Sonar detected secrets in file: ${filePath}`);
    }
  } catch (err) {
    logger.debug(`PreToolUse secrets scan failed: ${(err as Error).message}`);
  }

  return { agentSessionId };
}
