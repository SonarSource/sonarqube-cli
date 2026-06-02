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

// Copilot CLI custom instructions.
//
// Copilot ignores the output of the userPromptSubmitted and postToolUse
// hooks, so we cannot block secret-leaking prompts or push SQAA findings to
// the agent in-band. Instead, we install markdown instruction sections that
// (a) ask the agent to warn the user when a prompt appears to contain a
// secret, and (b) direct the agent to run `sonar analyze agentic` at
// end-of-turn for files modified in that turn.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { warn } from '../../../../ui';
import { buildSqaaSection, withSonarMarkers } from '../_common/instructions-templates';

export const INSTRUCTIONS_FILENAME = 'sonarqube.instructions.md';
export const PROJECT_INSTRUCTIONS_REL_DIR = join('.github', 'instructions');
export const GLOBAL_INSTRUCTIONS_DIR = join(homedir(), '.copilot', 'instructions');

const PROMPT_SECRETS_SECTION = withSonarMarkers(
  'copilot-prompt-secrets',
  `# SonarQube secrets scanning for prompts protocol

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
`,
);

export function buildInstructionsBody(projectKey?: string): string {
  const sections = [PROMPT_SECRETS_SECTION];
  if (projectKey) {
    sections.push(buildSqaaSection(projectKey));
  }
  return `${sections.join('\n\n').trimEnd()}\n`;
}

export function buildSqaaInstructionsBody(projectKey: string): string {
  return `${buildSqaaSection(projectKey).trimEnd()}\n`;
}

export function warnIfProjectInstructionsShadowGlobal(): void {
  const filePath = join(GLOBAL_INSTRUCTIONS_DIR, INSTRUCTIONS_FILENAME);
  if (!existsSync(filePath)) {
    return;
  }
  warn(
    `Found existing Copilot instructions at '${filePath}'; this run only updates the project-level file. Remove the existing one if it is no longer needed.`,
  );
}
