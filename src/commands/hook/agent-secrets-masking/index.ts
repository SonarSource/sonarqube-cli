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

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import {
  EXIT_CODE_SECRETS_FOUND,
  SECRETS_CALLER_COMMANDS,
  SECRETS_ERROR_SCANNING_TEMPLATE,
  SECRETS_NOTICE_BLOCKED_TEMPLATE,
  SECRETS_NOTICE_REDACTED,
} from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';

import { maskingDecision } from '../agent-secrets-hooks.ts';
import type { HookCommandResult } from '../hook-command-result.ts';
import {
  resolveAuthAndSecrets,
  runAndEmitTextSecretsScanWithIssues,
} from '../hook-dependencies.ts';
import { readStdinJson } from '../stdin.ts';
import { codexAdapter } from './agent-adapters/codex-adapter.ts';
import { copilotAdapter } from './agent-adapters/copilot-adapter.ts';
import type {
  SecretsMaskingAgent,
  SecretsMaskingAgentAdapter,
  SecretsMaskingInput,
  SecretsMaskingOutput,
} from './types.ts';

export async function agentSecretsMasking(
  ctx: CommandInvocationContext,
  agent: string,
): Promise<HookCommandResult> {
  let sessionId: string | undefined;
  try {
    const adapter = resolveAdapter(agent);
    if (!adapter) {
      logSkip(`unknown agent '${agent}'`);
      return { agentSessionId: null };
    }

    let input: SecretsMaskingInput;
    try {
      input = adapter.parse(await readStdinJson<unknown>());
    } catch {
      logSkip('unparseable stdin');
      return { agentSessionId: null };
    }
    sessionId = input.sessionId;

    const output = await handleSecretsMasking(ctx, input);
    if (output !== null) {
      process.stdout.write(JSON.stringify(adapter.emit(output)) + '\n');
    }
  } catch (err) {
    logSkip((err as Error).message);
  }
  return { agentSessionId: sessionId ?? null };
}

async function handleSecretsMasking(
  ctx: CommandInvocationContext,
  input: SecretsMaskingInput,
): Promise<SecretsMaskingOutput | null> {
  const toolOutput = input.toolOutput;
  if (!toolOutput) return null;

  try {
    const deps = await resolveAuthAndSecrets(ctx);
    const { exitCode, issues } = await runAndEmitTextSecretsScanWithIssues(
      SECRETS_CALLER_COMMANDS.agentSecretsMasking,
      deps,
      toolOutput,
      ctx,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      const decision = maskingDecision(toolOutput, issues);
      return {
        replacementToolOutput: decision.block
          ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            blockedMessage(decision.reason!)
          : `${decision.redactedText}\n\n${SECRETS_NOTICE_REDACTED}`,
      };
    }
    return exitCode === 0 ? null : scanFailureOutput(`scanner exit code ${exitCode}`);
  } catch (err) {
    return scanFailureOutput((err as Error).message);
  }
}

function scanFailureOutput(reason: string): SecretsMaskingOutput {
  logger.debug(`Secrets masking scan failed: ${reason}`);
  return {
    replacementToolOutput: blockedMessage(
      SECRETS_ERROR_SCANNING_TEMPLATE.replace('{reason}', () => reason),
    ),
  };
}

function blockedMessage(reason: string): string {
  return SECRETS_NOTICE_BLOCKED_TEMPLATE.replace('{reason}', () => reason);
}

function logSkip(reason: string): void {
  logger.debug(`Secrets masking skipped: ${reason}`);
}

const ADAPTERS: Record<SecretsMaskingAgent, SecretsMaskingAgentAdapter> = {
  codex: codexAdapter,
  copilot: copilotAdapter,
};

function resolveAdapter(agent: string): SecretsMaskingAgentAdapter | undefined {
  return Object.hasOwn(ADAPTERS, agent) ? ADAPTERS[agent as SecretsMaskingAgent] : undefined;
}
