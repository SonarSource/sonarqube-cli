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

// tool.execute.before callback handler for OpenCode — scans files for secrets before the agent
// reads them. Unlike the other agents' shell-script hooks, the OpenCode plugin calls this
// subcommand directly (no intermediate hook script) and always expects a JSON decision on
// stdout, whether the read is allowed or blocked — OpenCode has no "silent stdout means allow"
// convention to mirror, so we define our own explicit contract instead.

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

interface OpenCodePreToolUsePayload {
  tool?: string;
  filePath?: string;
  sessionID?: string;
}

interface OpenCodePreToolUseDecision {
  block: boolean;
  reason?: string;
}

function writeDecision(decision: OpenCodePreToolUseDecision): void {
  process.stdout.write(JSON.stringify(decision) + '\n');
}

export async function opencodePreToolUse(
  ctx: CommandInvocationContext,
): Promise<HookCommandResult> {
  let payload: OpenCodePreToolUsePayload;
  try {
    payload = await readStdinJson<OpenCodePreToolUsePayload>();
  } catch {
    writeDecision({ block: false }); // unparseable stdin — allow
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
      SECRETS_CALLER_COMMANDS.opencodePreToolUse,
      deps,
      filePath,
      ctx,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      writeDecision({ block: true, reason: `Sonar detected secrets in file: ${filePath}` });
      return { agentSessionId };
    }
  } catch (err) {
    logger.debug(`opencode-pre-tool-use secrets scan failed: ${(err as Error).message}`);
    writeDecision({ block: false });
    return { agentSessionId };
  }

  writeDecision({ block: false });
  return { agentSessionId };
}
