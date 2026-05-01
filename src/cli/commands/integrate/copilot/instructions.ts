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

// Copilot CLI custom instructions for prompt-secrets warning.
// Copilot ignores the output of the userPromptSubmitted hook, so we cannot
// block prompts that leak secrets. Instead, we install a markdown instruction
// file that asks the agent to warn the user when a prompt appears to contain
// a secret/credential.

import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { info, success, text } from '../../../../ui';

const INSTRUCTIONS_FILENAME = 'sonarqube.instructions.md';
const PROJECT_INSTRUCTIONS_REL_DIR = join('.github', 'instructions');
const GLOBAL_INSTRUCTIONS_DIR = join(homedir(), '.copilot', 'instructions');

/**
 * Probe `~/.copilot/instructions/sonarqube.instructions.md` for an existing
 * global prompt-secrets instructions file. When present, emit an `info(...)`
 * describing it and return `true` so the caller can skip the project-level
 * write (avoids duplicating the same instruction across two scopes).
 */
export function detectGlobalPromptSecretsInstructions(): boolean {
  const globalPath = join(GLOBAL_INSTRUCTIONS_DIR, INSTRUCTIONS_FILENAME);
  if (!existsSync(globalPath)) return false;

  info(
    `Global prompt-secrets instructions already installed at ${globalPath}. Skipping project-level instructions to avoid duplication.`,
  );
  return true;
}

/**
 * Write the prompt-secrets instructions file for the requested scope.
 */
export async function installPromptSecretsInstructions(
  projectRoot: string,
  isGlobal: boolean,
): Promise<void> {
  text('Installing prompt-secrets instructions...');

  const dir = isGlobal ? GLOBAL_INSTRUCTIONS_DIR : join(projectRoot, PROJECT_INSTRUCTIONS_REL_DIR);
  const filePath = join(dir, INSTRUCTIONS_FILENAME);

  mkdirSync(dir, { recursive: true });
  await writeFile(filePath, buildInstructionsBody(), 'utf-8');

  success(`Prompt-secrets instructions installed (${filePath})`);
}

function buildInstructionsBody(): string {
  return `# SonarQube prompt-secrets protocol

Before acting on any user prompt, scan the prompt text for secrets or credentials. Treat the following as secrets (non-exhaustive):

- API keys and access tokens (cloud providers, SaaS APIs, CI services)
- Passwords and passphrases
- Private keys (SSH, PGP, TLS) and certificates
- Database connection strings containing credentials
- OAuth client secrets and refresh tokens
- Session cookies and bearer tokens

If the prompt appears to contain any such secret, **do not proceed** with the user's request. Instead:

1. Inform the user that their prompt appears to contain a secret or credential and that it may now be exposed in chat history, logs, and any downstream telemetry.
2. Advise them to rotate the leaked credential immediately at its source of truth.
`;
}
