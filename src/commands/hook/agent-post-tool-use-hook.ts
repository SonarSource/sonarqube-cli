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

import type { SqaaTelemetryCallerCommand } from '@/commands/analyze/sqaa-analysis-telemetry.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import logger from '@/core/observability/logger.ts';

import type { HookCommandResult } from './hook-command-result.ts';
import { analyzeEditedSqaaFile } from './sqaa-edited-file.ts';
import { readStdinJson } from './stdin.ts';
import { resolveVortexUnavailableHookNotice } from './vortex-unavailable-hook-notice.ts';

const SQAA_TOOLS = new Set(['edit', 'write']);

interface PostToolUsePayload {
  tool?: string;
  filePath?: string;
  sessionID?: string;
}

interface PostToolUseResult {
  context?: string;
}

interface PostToolUseHookOptions {
  callerCommand: SqaaTelemetryCallerCommand;
  logPrefix: string;
}

function writeResult(result: PostToolUseResult): void {
  process.stdout.write(JSON.stringify(result) + '\n');
}

export function createPostToolUseHook(
  options: PostToolUseHookOptions,
): (ctx: CommandInvocationContext) => Promise<HookCommandResult> {
  return async (ctx) => {
    let payload: PostToolUsePayload;
    try {
      payload = await readStdinJson<PostToolUsePayload>();
    } catch {
      writeResult({});
      return { agentSessionId: null };
    }

    const agentSessionId = payload.sessionID ?? null;
    const filePath = payload.filePath;

    if (!SQAA_TOOLS.has(payload.tool ?? '') || !filePath) {
      writeResult({});
      return { agentSessionId };
    }

    try {
      const result = await analyzeEditedSqaaFile(filePath, ctx, options.callerCommand);
      const context =
        result?.kind === 'forbidden'
          ? await resolveVortexUnavailableHookNotice(result.connection)
          : result?.context;
      writeResult(context === undefined ? {} : { context });
    } catch (err) {
      logger.debug(`${options.logPrefix} failed: ${(err as Error).message}`);
      writeResult({});
    }
    return { agentSessionId };
  };
}
