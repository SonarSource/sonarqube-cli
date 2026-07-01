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

// beforeSubmitPrompt callback handler for Cursor — scans prompt text for secrets before it is sent.
//
// Cursor's beforeSubmitPrompt stdin payload exposes the user prompt at the same top-level `prompt`
// field as Claude and Codex, so the scanning core is shared. The block-output contract differs:
// Cursor expects `{ "continue": false, "user_message": "..." }` rather than Claude/Codex's
// `{ "decision": "block", "reason": "..." }`, which is why this handler is separate from
// `agentPromptSubmit`.

import logger from '../../../lib/logger';
import { SECRETS_CALLER_COMMANDS } from '../../../telemetry/secrets-analysis-telemetry.js';
import { EXIT_CODE_SECRETS_FOUND } from '../analyze/secrets';
import { resolveAuthAndSecrets, runAndEmitTextSecretsScan } from './hook-dependencies';
import { readStdinJson } from './stdin';

interface CursorPromptSubmitPayload {
  prompt?: string;
}

export async function cursorPromptSubmit(): Promise<void> {
  let payload: CursorPromptSubmitPayload;
  try {
    payload = await readStdinJson<CursorPromptSubmitPayload>();
  } catch (err) {
    logger.debug(`beforeSubmitPrompt: failed to parse stdin — ${(err as Error).message}`);
    return; // unparseable stdin — allow
  }

  const prompt = payload.prompt;
  if (!prompt) return;

  const deps = await resolveAuthAndSecrets();
  if (!deps) return;

  try {
    const exitCode = await runAndEmitTextSecretsScan(
      SECRETS_CALLER_COMMANDS.cursorPromptSubmit,
      deps,
      prompt,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      process.stdout.write(
        JSON.stringify({ continue: false, user_message: 'Sonar detected secrets in prompt' }) +
          '\n',
      );
    }
  } catch (err) {
    logger.debug(`beforeSubmitPrompt secrets scan failed: ${(err as Error).message}`);
  }
}
