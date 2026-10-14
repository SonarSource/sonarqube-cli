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

interface PiPreToolUsePayload {
  tool?: string;
  filePath?: string;
  sessionID?: string;
}

interface PiPreToolUseDecision {
  block: boolean;
  reason?: string;
}

function writeDecision(decision: PiPreToolUseDecision): void {
  process.stdout.write(JSON.stringify(decision) + '\n');
}

export async function piPreToolUse(ctx: CommandInvocationContext): Promise<HookCommandResult> {
  let payload: PiPreToolUsePayload;
  try {
    payload = await readStdinJson<PiPreToolUsePayload>();
  } catch {
    writeDecision({ block: false });
    return { agentSessionId: null };
  }

  const agentSessionId = payload.sessionID ?? null;

  if (payload.tool !== 'read') {
    writeDecision({ block: false });
    return { agentSessionId };
  }

  const filePath = payload.filePath;
  if (!filePath || !existsSync(filePath)) {
    writeDecision({ block: false });
    return { agentSessionId };
  }

  let deps: HookDependencies;
  try {
    deps = await resolveAuthAndSecrets(ctx);
  } catch (err) {
    if (err instanceof MissingDependenciesError) {
      writeDecision({ block: true, reason: err.message });
      return { agentSessionId };
    }
    throw err;
  }

  try {
    const exitCode = await runAndEmitFileSecretsScan(
      SECRETS_CALLER_COMMANDS.piPreToolUse,
      deps,
      filePath,
      ctx,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      writeDecision({ block: true, reason: `Sonar detected secrets in file: ${filePath}` });
      return { agentSessionId };
    }
    if (exitCode !== 0) {
      writeDecision({
        block: true,
        reason: `SonarQube secret scanning failed (exit code ${exitCode}).`,
      });
      return { agentSessionId };
    }
  } catch (err) {
    logger.debug(`pi-pre-tool-use secrets scan failed: ${(err as Error).message}`);
    writeDecision({
      block: true,
      reason: `SonarQube secret scanning failed unexpectedly: ${(err as Error).message}`,
    });
    return { agentSessionId };
  }

  writeDecision({ block: false });
  return { agentSessionId };
}
