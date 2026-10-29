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

// PreToolUse callback handler for GitHub Copilot CLI — scans files for secrets
// before the agent reads them. Output schema differs from the Claude one
// (`permissionDecision`/`permissionDecisionReason` vs `decision`/`reason`),
// so this handler cannot be reused across agents.
//
// Behaviour contract (differs from the Claude hook):
//   - Always exits 0 (hook must never crash Copilot CLI)
//   - CamelCase stdin payload accepts toolArgs as an object or a JSON-encoded string
//   - Outputs {"permissionDecision":"deny","permissionDecisionReason":"..."} on a hit
//     (no `hookSpecificOutput` wrapper)
//   - Outputs nothing when the file is clean, tool is not `view`, or args/file are missing

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { EXIT_CODE_SECRETS_FOUND, SECRETS_CALLER_COMMANDS } from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';

import {
  type HookDependencies,
  MissingDependenciesError,
  resolveAuthAndSecrets,
  runAndEmitFileSecretsScan,
} from './hook-dependencies.ts';
import { readStdinJson } from './stdin.ts';

interface CopilotPreToolUsePayload {
  toolName?: string;
  cwd?: string;
  toolArgs?: unknown;
}

interface CopilotViewToolArgs {
  path?: string;
}

function denyToolUse(reason: string): void {
  process.stdout.write(
    JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason }) + '\n',
  );
}

export async function copilotPreToolUse(ctx: CommandInvocationContext): Promise<void> {
  let payload: CopilotPreToolUsePayload;
  try {
    payload = await readStdinJson<CopilotPreToolUsePayload>();
  } catch {
    return;
  }

  // Only the dedicated file-read tool is scanned.
  if (payload.toolName !== 'view') return;

  const path = extractPath(payload.toolArgs);
  if (!path) return;
  const filePath = resolve(payload.cwd ?? process.cwd(), path);
  if (!existsSync(filePath)) return;

  let deps: HookDependencies;
  try {
    deps = await resolveAuthAndSecrets(ctx);
  } catch (err) {
    if (err instanceof MissingDependenciesError) {
      denyToolUse(err.message);
      return;
    }
    throw err;
  }

  try {
    const exitCode = await runAndEmitFileSecretsScan(
      SECRETS_CALLER_COMMANDS.copilotPreToolUse,
      deps,
      filePath,
      ctx,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      denyToolUse(`Sonar detected secrets in file: ${filePath}`);
    }
  } catch (err) {
    logger.debug(`Copilot PreToolUse secrets scan failed: ${(err as Error).message}`);
  }
}

function extractPath(toolArgs: unknown): string | undefined {
  try {
    const parsed: unknown = typeof toolArgs === 'string' ? JSON.parse(toolArgs) : toolArgs;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const { path } = parsed as CopilotViewToolArgs;
    return typeof path === 'string' && path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
}
