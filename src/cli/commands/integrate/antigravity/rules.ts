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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ANTIGRAVITY_GLOBAL_GEMINI_MD,
  ANTIGRAVITY_LEGACY_GLOBAL_INSTRUCTIONS_PATH,
  ANTIGRAVITY_LEGACY_PROJECT_INSTRUCTIONS_PATH,
} from '../../../../lib/config-constants';
import { sonarBeginMarker } from '../_common/instructions-templates';

export { PROMPT_SECRETS_BODY } from '../copilot/instructions';

export const PROMPT_SECRETS_RULE_MARKER = '# SonarQube secrets scanning for prompts protocol';
export const SQAA_RULE_MARKER = '# SonarQube Agentic Analysis protocol';

/** Render an Antigravity workspace rule (`.agents/rules/*.md`) with always-on activation. */
export function buildAntigravityAlwaysOnRule(body: string): string {
  return `---\ntrigger: always_on\n---\n\n${body.trimEnd()}\n`;
}

/**
 * True when a global Sonar prompt-secrets rule is already present (legacy instructions
 * file or managed snippet in `~/.gemini/GEMINI.md`).
 */
export function globalAntigravityPromptSecretsRuleExists(): boolean {
  if (existsSync(ANTIGRAVITY_LEGACY_GLOBAL_INSTRUCTIONS_PATH)) {
    return true;
  }
  if (!existsSync(ANTIGRAVITY_GLOBAL_GEMINI_MD)) {
    return false;
  }
  const content = readFileSync(ANTIGRAVITY_GLOBAL_GEMINI_MD, 'utf-8');
  return content.includes(sonarBeginMarker('antigravity-prompt-secrets'));
}

export function resolveLegacyProjectInstructionsPath(targetRoot: string): string {
  return join(targetRoot, ANTIGRAVITY_LEGACY_PROJECT_INSTRUCTIONS_PATH);
}

/** Legacy global instructions path from releases before Rules support. */
export function resolveLegacyGlobalInstructionsPath(): string {
  return ANTIGRAVITY_LEGACY_GLOBAL_INSTRUCTIONS_PATH;
}
