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

// Shared helpers for Antigravity integration tests.

import { join } from 'node:path';

import { expect } from 'bun:test';

import { hookScriptName, TestHarness } from '../../harness';
import { findInstalledFeature, type InstalledIntegrationFeature } from './state-helpers';

export type { InstalledIntegration, InstalledIntegrationFeature } from './state-helpers';

export const PRETOOL_SECRETS_SCRIPT = hookScriptName('pretool-secrets');

export const PROJECT_HOOK_SCRIPT_PATH = [
  '.agents',
  'sonar',
  'hooks',
  PRETOOL_SECRETS_SCRIPT,
] as const;

export const GLOBAL_HOOK_SCRIPT_PATH = [
  '.gemini',
  'config',
  'sonar',
  'hooks',
  PRETOOL_SECRETS_SCRIPT,
] as const;

export const PROJECT_HOOKS_JSON_PATH = ['.agents', 'hooks.json'] as const;
export const GLOBAL_HOOKS_JSON_PATH = ['.gemini', 'config', 'hooks.json'] as const;

/** Antigravity MCP config (`Manage MCP Servers` → View raw config). */
export const GLOBAL_MCP_CONFIG_PATH = ['.gemini', 'config', 'mcp_config.json'] as const;

export const PROJECT_PROMPT_SECRETS_RULE_PATH = [
  '.agents',
  'rules',
  'sonar-prompt-secrets.md',
] as const;

export const PROJECT_SQAA_RULE_PATH = ['.agents', 'rules', 'sonar-agentic-analysis.md'] as const;

export const GLOBAL_GEMINI_MD_PATH = ['.gemini', 'GEMINI.md'] as const;

/** @deprecated Use PROJECT_PROMPT_SECRETS_RULE_PATH — legacy instructions layout. */
export const PROJECT_INSTRUCTIONS_PATH = [
  '.agents',
  'instructions',
  'sonarqube.instructions.md',
] as const;

export interface AntigravityHooksJson {
  'sonar-secrets'?: {
    enabled?: boolean;
    PreToolUse?: Array<{
      matcher: string;
      hooks: Array<{ type?: string; command: string; timeout?: number }>;
    }>;
  };
  'other-hook'?: Record<string, unknown>;
}

export function findAntigravityFeature(
  harness: TestHarness,
  featureId: string,
  scope?: string,
): InstalledIntegrationFeature | undefined {
  return findInstalledFeature(harness, 'antigravity', featureId, scope);
}

/** Simulates a pre-existing global Sonar rules snippet in GEMINI.md. */
export function writeExistingGlobalGeminiRules(harness: TestHarness): void {
  harness.userHome.writeFile(join('.gemini', 'GEMINI.md'), '# pre-existing global rules\n');
}

export function expectAntigravityAlwaysOnRule(body: string): void {
  expect(body.startsWith('---\n')).toBe(true);
  expect(body).toContain('trigger: always_on');
}
