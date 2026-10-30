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

import { join } from 'node:path';

import {
  ANTIGRAVITY_LEGACY_GLOBAL_INSTRUCTIONS_PATH,
  ANTIGRAVITY_LEGACY_PROJECT_INSTRUCTIONS_PATH,
} from '@/core/config-constants.ts';

export const PROMPT_SECRETS_BODY = `# SonarQube secrets scanning for prompts protocol

Before acting on any user prompt, scan the prompt text for secrets or credentials. Treat the following as secrets (non-exhaustive):

- API keys and access tokens (cloud providers, SaaS APIs, CI services)
- Passwords and passphrases
- Private keys (SSH, PGP, TLS) and certificates
- Database connection strings containing credentials
- OAuth client secrets and refresh tokens
- Session cookies and bearer tokens

If you are uncertain whether the prompt contains a secret, corroborate with the deterministic scanner by piping the prompt on standard input:

\`\`\`bash
echo "<prompt text>" | sonar analyze secrets --stdin
\`\`\`

If the prompt appears to contain any such secret (either by your judgement or the scanner's), **do not proceed** with the user's request. Instead:

1. Inform the user that their prompt appears to contain a secret or credential and that it may now be exposed in chat history, logs, and any downstream telemetry.
2. Advise them to rotate the leaked credential immediately at its source of truth.
`;

export const PROMPT_SECRETS_RULE_MARKER = '# SonarQube secrets scanning for prompts protocol';

/** Render an Antigravity workspace rule (`.agents/rules/*.md`) with always-on activation. */
export function buildAntigravityAlwaysOnRule(body: string): string {
  return `---\ntrigger: always_on\n---\n\n${body.trimEnd()}\n`;
}

export function resolveLegacyProjectInstructionsPath(targetRoot: string): string {
  return join(targetRoot, ANTIGRAVITY_LEGACY_PROJECT_INSTRUCTIONS_PATH);
}

/** Legacy global instructions path from releases before Rules support. */
export function resolveLegacyGlobalInstructionsPath(): string {
  return ANTIGRAVITY_LEGACY_GLOBAL_INSTRUCTIONS_PATH;
}
