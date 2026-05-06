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
//   - Stdin payload is { toolName: "view", toolArgs: "<JSON-encoded string>" }
//     (camelCase; toolArgs is a stringified JSON, not a nested object)
//   - Outputs {"permissionDecision":"deny","permissionDecisionReason":"..."} on a hit
//     (no `hookSpecificOutput` wrapper)
//   - Outputs nothing when the file is clean, tool is not `view`, or args/file are missing

import { existsSync } from 'node:fs';

import logger from '../../../lib/logger';
import { EXIT_CODE_SECRETS_FOUND, runSecretsBinary } from '../analyze/secrets';
import { resolveAuthAndSecrets } from './hook-dependencies';
import { readStdinJson } from './stdin';

interface CopilotPreToolUsePayload {
  toolName?: string;
  /** JSON-encoded string containing the tool's arguments. */
  toolArgs?: string;
}

interface CopilotViewToolArgs {
  path?: string;
}

export async function copilotPreToolUse(): Promise<void> {
  let payload: CopilotPreToolUsePayload;
  try {
    payload = await readStdinJson<CopilotPreToolUsePayload>();
  } catch {
    return;
  }

  // Only the dedicated file-read tool is scanned.
  if (payload.toolName !== 'view') return;

  const filePath = extractPath(payload.toolArgs);
  if (!filePath || !existsSync(filePath)) return;

  const deps = await resolveAuthAndSecrets();
  if (!deps) return;

  try {
    const result = await runSecretsBinary(deps.binaryPath, [filePath], deps.auth);
    const exitCode = result.exitCode ?? 1;
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      process.stdout.write(
        JSON.stringify({
          permissionDecision: 'deny',
          permissionDecisionReason: `Sonar detected secrets in file: ${filePath}`,
        }) + '\n',
      );
    }
  } catch (err) {
    logger.debug(`Copilot PreToolUse secrets scan failed: ${(err as Error).message}`);
  }
}

function extractPath(toolArgs: string | undefined): string | undefined {
  if (!toolArgs) return undefined;
  try {
    const parsed = JSON.parse(toolArgs) as CopilotViewToolArgs;
    return parsed.path;
  } catch {
    return undefined;
  }
}
