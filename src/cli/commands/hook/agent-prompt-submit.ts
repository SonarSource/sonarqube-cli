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

import logger from '../../../lib/logger';
import { EXIT_CODE_SECRETS_FOUND, runSecretsBinaryOnText } from '../analyze/secrets';
import { resolveAuthAndSecrets } from './hook-dependencies';
import { readStdinJson } from './stdin';

interface PromptSubmitPayload {
  prompt?: string;
}

export async function agentPromptSubmit(): Promise<void> {
  let payload: PromptSubmitPayload;
  try {
    payload = await readStdinJson<PromptSubmitPayload>();
  } catch (err) {
    logger.debug(`UserPromptSubmit: failed to parse stdin — ${(err as Error).message}`);
    return; // unparseable stdin — allow
  }

  const prompt = payload.prompt;
  if (!prompt) return;

  const deps = await resolveAuthAndSecrets();
  if (!deps) return;

  try {
    const result = await runSecretsBinaryOnText(deps.binaryPath, prompt, deps.auth);
    const exitCode = result.exitCode ?? 1;
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      process.stdout.write(
        JSON.stringify({ decision: 'block', reason: 'Sonar detected secrets in prompt' }) + '\n',
      );
    }
  } catch (err) {
    logger.debug(`UserPromptSubmit secrets scan failed: ${(err as Error).message}`);
  }
}
