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

import logger from '../../../lib/logger';
import { SECRETS_CALLER_COMMANDS } from '../../../telemetry/secrets-analysis-telemetry.js';
import { EXIT_CODE_SECRETS_FOUND } from '../analyze/secrets';
import { resolveAuthAndSecrets, runAndEmitFileSecretsScan } from './hook-dependencies';
import { readStdinJson } from './stdin';

interface AntigravityPreToolUsePayload {
  toolCall?: {
    name?: string;
    args?: {
      AbsolutePath?: string;
    };
  };
}

export async function antigravityPreToolUse(): Promise<void> {
  let payload: AntigravityPreToolUsePayload;
  try {
    payload = await readStdinJson<AntigravityPreToolUsePayload>();
  } catch {
    return;
  }

  if (payload.toolCall?.name !== 'view_file') return;

  const filePath = payload.toolCall.args?.AbsolutePath;
  if (!filePath || !existsSync(filePath)) return;

  const deps = await resolveAuthAndSecrets();
  if (!deps) return;

  try {
    const exitCode = await runAndEmitFileSecretsScan(
      SECRETS_CALLER_COMMANDS.antigravityPreToolUse,
      deps,
      filePath,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      process.stdout.write(
        JSON.stringify({
          decision: 'deny',
          reason: `Sonar detected secrets in file: ${filePath}`,
        }) + '\n',
      );
    }
  } catch (err) {
    logger.debug(`Antigravity PreToolUse secrets scan failed: ${(err as Error).message}`);
  }
}
