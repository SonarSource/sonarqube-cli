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
// Copilot ignores the output of the userPromptSubmitted hook, so we cannot
// block prompts that leak secrets. Instead, we install a markdown instruction
// file that asks the agent to warn the user when a prompt appears to contain
// a secret/credential.
//
// Copilot also ignores the output of the postToolUse hook (unlike Claude,
// which feeds it back to the model), so we cannot push SQAA findings to the
// agent in-band. Instead, we append a SQAA section to the same instruction
// file directing the agent to run `sonar analyze sqaa` at end-of-turn. Only
// included when SQAA-entitled, project-scoped, and a project key is known.

import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { info, success, text, warn } from '../../../../ui';

export interface InstructionsInstallResult {
  /* Absolute path of the active instructions file. `undefined` when installation failed. */
  instructionsPath?: string;
  instructionsInstalled: boolean;
}

const INSTRUCTIONS_FILENAME = 'sonarqube.instructions.md';
const PROJECT_INSTRUCTIONS_REL_DIR = join('.github', 'instructions');
const GLOBAL_INSTRUCTIONS_DIR = join(homedir(), '.copilot', 'instructions');

/**
 * Probe `~/.copilot/instructions/sonarqube.instructions.md` for an existing
 * global instructions file. Returns the path when present (caller should skip
 * the project-level write), `undefined` otherwise.
 */
function detectGlobalCustomInstructions(): string | undefined {
  const globalPath = join(GLOBAL_INSTRUCTIONS_DIR, INSTRUCTIONS_FILENAME);
  if (!existsSync(globalPath)) return undefined;

  info(
    `Global prompt-secrets instructions already installed at ${globalPath}. Skipping project-level instructions to avoid duplication.`,
  );
  return globalPath;
}

/**
 * Write the instructions file for the requested scope.
 */
async function installCustomInstructions(
  projectRoot: string,
  isGlobal: boolean,
  sqaaProjectKey: string | undefined,
): Promise<string> {
  text('Installing prompt-secrets instructions...');

  const dir = isGlobal ? GLOBAL_INSTRUCTIONS_DIR : join(projectRoot, PROJECT_INSTRUCTIONS_REL_DIR);
  const filePath = join(dir, INSTRUCTIONS_FILENAME);

  mkdirSync(dir, { recursive: true });
  await writeFile(filePath, buildInstructionsBody(sqaaProjectKey), 'utf-8');

  success(`Prompt-secrets instructions installed (${filePath})`);
  return filePath;
}

export async function installInstructions(
  projectRoot: string,
  isGlobal: boolean,
  sqaaProjectKey?: string,
): Promise<InstructionsInstallResult> {
  try {
    if (!isGlobal) {
      const existingGlobalInstructionsPath = detectGlobalCustomInstructions();
      if (existingGlobalInstructionsPath) {
        return { instructionsPath: existingGlobalInstructionsPath, instructionsInstalled: false };
      }
    }
    const instructionsPath = await installCustomInstructions(projectRoot, isGlobal, sqaaProjectKey);
    return { instructionsPath, instructionsInstalled: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warn(
      `Failed to install prompt-secrets instructions: ${detail}. Prompt-secrets warnings will not be available.`,
    );
    return { instructionsInstalled: false };
  }
}

function buildInstructionsBody(sqaaProjectKey: string | undefined): string {
  const sections = [PROMPT_SECRETS_SECTION];
  if (sqaaProjectKey) {
    sections.push(buildSqaaSection(sqaaProjectKey));
  }
  return sections.join('\n');
}

const PROMPT_SECRETS_SECTION = `# SonarQube prompt-secrets protocol

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

function buildSqaaSection(projectKey: string): string {
  return `# SonarQube Agentic Analysis (SQAA) protocol

SQAA is the final confirmation layer at the end of every turn in which you wrote to one or more files in the workspace (create, edit, patch, format — any tool call that changed file contents on disk).

**Trigger:** the moment before you send your final reply for the turn.

When the trigger fires, you **MUST**:

1. Build the set of unique file paths you modified during this turn.
2. Run SQAA once for each unique path. The command analyses one file per invocation:

\`\`\`bash
sonar analyze sqaa --project ${projectKey} --file <path/to/modified/file>
\`\`\`

Non-negotiable rules:

1. Mid-turn edits do **not** need SQAA — only the final on-disk state matters. Skipping SQAA for any modified file at end-of-turn is a protocol violation.
2. Run SQAA **before** sending your final reply, marking the task done, or handing control back to the user.
3. If SQAA reports issues on lines you touched in this turn, fix them, then re-run SQAA on that file. Repeat until the file is clean (or only pre-existing findings on lines you did not touch remain). Pre-existing findings on untouched lines are out of scope — do not "fix" them unless the user asked.
4. If SQAA is skipped (no SonarQube Cloud connection, or no project configured), state the skip reason to the user once and continue — do not retry.
5. Do not suppress, summarize away, or omit SQAA findings from your reply. Surface them verbatim.
`;
}
