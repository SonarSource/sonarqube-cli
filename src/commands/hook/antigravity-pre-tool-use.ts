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

// PreToolUse callback handler for Antigravity — scans files for secrets before
// the agent reads them via `view_file`.
//
// Behaviour contract:
//   - Always exits 0 (hook must never crash Antigravity)
//   - Stdin payload is { toolCall: { name: "view_file", args: { AbsolutePath: "<path>" } } }
//     (camelCase; args is a nested object, not a JSON-encoded string)
//   - Outputs {"decision":"deny","reason":"..."} on a hit (flat schema, no wrapper)
//   - Outputs nothing when the file is clean, tool is not `view_file`, or args/file are missing

import { existsSync } from 'node:fs';

import { SECRETS_CALLER_COMMANDS } from '@/commands/analyze/secrets-analysis-telemetry.ts';
import type { CommandInvocationContext } from '@/commands/command-invocation-context.ts';
import logger from '@/core/observability/logger.ts';

import { EXIT_CODE_SECRETS_FOUND } from '../analyze/secrets.ts';
import {
  type HookDependencies,
  MissingDependenciesError,
  resolveAuthAndSecrets,
  runAndEmitFileSecretsScan,
} from './hook-dependencies.ts';
import { readStdinJson } from './stdin.ts';

interface AntigravityPreToolUsePayload {
  toolCall?: {
    name?: string;
    args?: {
      AbsolutePath?: string;
    };
  };
}

function denyToolUse(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason }) + '\n');
}

export async function antigravityPreToolUse(ctx: CommandInvocationContext): Promise<void> {
  let payload: AntigravityPreToolUsePayload;
  try {
    payload = await readStdinJson<AntigravityPreToolUsePayload>();
  } catch {
    return;
  }

  if (payload.toolCall?.name !== 'view_file') return;

  const filePath = payload.toolCall.args?.AbsolutePath;
  if (!filePath || !existsSync(filePath)) return;

  let deps: HookDependencies;
  try {
    deps = await resolveAuthAndSecrets();
  } catch (err) {
    if (err instanceof MissingDependenciesError) {
      denyToolUse(err.message);
      return;
    }
    throw err;
  }

  try {
    const exitCode = await runAndEmitFileSecretsScan(
      SECRETS_CALLER_COMMANDS.antigravityPreToolUse,
      deps,
      filePath,
      ctx,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      denyToolUse(`Sonar detected secrets in file: ${filePath}`);
    }
  } catch (err) {
    logger.debug(`Antigravity PreToolUse secrets scan failed: ${(err as Error).message}`);
  }
}
