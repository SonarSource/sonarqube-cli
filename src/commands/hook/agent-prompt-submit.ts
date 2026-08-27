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

// UserPromptSubmit callback handler — scans prompt text for secrets before it is sent.
// Replaces the bash/PowerShell logic that was previously embedded in the hook script.

import type { CommandInvocationContext } from '@/commands/command-invocation-context.ts';
import logger from '@/core/observability/logger.ts';
import { SECRETS_CALLER_COMMANDS } from '@/core/telemetry/secrets-analysis-telemetry.ts';

import { EXIT_CODE_SECRETS_FOUND } from '../analyze/secrets.ts';
import type { HookCommandResult } from './hook-command-result.ts';
import {
  type HookDependencies,
  MissingDependenciesError,
  resolveAuthAndSecrets,
  runAndEmitTextSecretsScan,
} from './hook-dependencies.ts';
import { readStdinJson } from './stdin.ts';

interface PromptSubmitPayload {
  prompt?: string;
  session_id?: string;
}

function denyPrompt(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
}

export async function agentPromptSubmit(ctx: CommandInvocationContext): Promise<HookCommandResult> {
  let payload: PromptSubmitPayload;
  try {
    payload = await readStdinJson<PromptSubmitPayload>();
  } catch (err) {
    logger.debug(`UserPromptSubmit: failed to parse stdin — ${(err as Error).message}`);
    return { agentSessionId: null }; // unparseable stdin — allow
  }

  const agentSessionId = payload.session_id ?? null;

  const prompt = payload.prompt;
  if (!prompt) return { agentSessionId };

  let deps: HookDependencies;
  try {
    deps = await resolveAuthAndSecrets();
  } catch (err) {
    if (err instanceof MissingDependenciesError) {
      denyPrompt(err.message);
      return { agentSessionId };
    }
    throw err;
  }

  try {
    const exitCode = await runAndEmitTextSecretsScan(
      SECRETS_CALLER_COMMANDS.agentPromptSubmit,
      deps,
      prompt,
      ctx,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      denyPrompt('Sonar detected secrets in prompt');
    }
  } catch (err) {
    logger.debug(`UserPromptSubmit secrets scan failed: ${(err as Error).message}`);
  }

  return { agentSessionId };
}
