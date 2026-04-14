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

// PreToolUse callback handler — scans files for secrets before the agent reads them.
// Replaces the bash/PowerShell logic that was previously embedded in the hook script.

import { existsSync } from 'node:fs';
import logger from '../../../lib/logger';
import { readStdinJson } from './stdin';
import { resolveAuthAndSecrets } from './hook-dependencies';
import { EXIT_CODE_SECRETS_FOUND, runSecretsBinary } from '../analyze/secrets';

interface PreToolUsePayload {
  tool_name?: string;
  tool_input?: { file_path?: string };
}

export async function claudePreToolUse(): Promise<void> {
  let payload: PreToolUsePayload;
  try {
    payload = await readStdinJson<PreToolUsePayload>();
  } catch {
    return; // unparseable stdin — allow
  }

  if (payload.tool_name !== 'Read') return;

  const filePath = payload.tool_input?.file_path;
  if (!filePath || !existsSync(filePath)) return;

  const deps = await resolveAuthAndSecrets();
  if (!deps) return;

  try {
    const result = await runSecretsBinary(deps.binaryPath, [filePath], deps.auth);
    const exitCode = result.exitCode ?? 1;
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Sonar detected secrets in file: ${filePath}`,
          },
        }) + '\n',
      );
    }
  } catch (err) {
    logger.debug(`PreToolUse secrets scan failed: ${(err as Error).message}`);
  }
}
