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

// Shared helpers and types for copilot integration tests.

import { mkdirSync } from 'node:fs';

import { expect } from 'bun:test';

import { hookScriptName, IS_WINDOWS, normalizePath, TestHarness } from '../../harness';

export const HOOK_FIELD = IS_WINDOWS ? 'powershell' : 'bash';

export const PRETOOL_SECRETS_SCRIPT = hookScriptName('pretool-secrets');
export const PROJECT_HOOK_SCRIPT_PATH = [
  '.github',
  'hooks',
  'sonar-secrets',
  'build-scripts',
  PRETOOL_SECRETS_SCRIPT,
] as const;
export const GLOBAL_HOOK_SCRIPT_PATH = [
  '.copilot',
  'hooks',
  'sonar-secrets',
  'build-scripts',
  PRETOOL_SECRETS_SCRIPT,
] as const;
export const PROJECT_INSTRUCTIONS_PATH = [
  '.github',
  'instructions',
  'sonarqube.instructions.md',
] as const;
export const GLOBAL_INSTRUCTIONS_PATH = [
  '.copilot',
  'instructions',
  'sonarqube.instructions.md',
] as const;
export const PROJECT_HOOKS_JSON_PATH = ['.github', 'hooks', 'hooks.json'] as const;
export const GLOBAL_HOOKS_JSON_PATH = ['.copilot', 'hooks', 'hooks.json'] as const;

export interface CopilotHookEntry {
  type: 'command';
  bash?: string;
  powershell?: string;
  timeoutSec?: number;
}

export interface CopilotHooksJson {
  version: number;
  hooks: { preToolUse?: CopilotHookEntry[] };
}

export interface McpJson {
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

export interface AgentExt {
  kind: string;
  name: string;
  hookType?: string;
  global?: boolean;
  projectRoot?: string;
  projectKey?: string;
  orgKey?: string;
  serverUrl?: string;
}

/** Builds a platform-correct `CopilotHookEntry` for the given command path. */
export function makeHookEntry(commandPath: string): CopilotHookEntry {
  return { type: 'command', timeoutSec: 60, [HOOK_FIELD]: commandPath };
}

/**
 * Returns the line in `stdout` that begins with `prefix` (e.g. `"Hook:"` or
 * `"Instructions:"`), asserting that exactly one such line exists.
 */
export function outcomeLine(
  stdout: string,
  prefix:
    | 'Hook:'
    | 'Instructions (secrets scanning for prompts):'
    | 'Instructions (SonarQube Agentic Analysis):',
): string {
  const line = stdout.split('\n').find((l) => l.startsWith(prefix));
  expect(line).toBeDefined();
  return line ?? '';
}

/** Returns all `agentExtensions` from the persisted CLI state file. */
export function getStateExtensions(harness: TestHarness): AgentExt[] {
  const state = harness.stateJsonFile.asJson();
  return (state.agentExtensions ?? []) as AgentExt[];
}

/** Finds the `sonar-secrets` hook extension in state, or `undefined` if absent. */
export function findSonarHookExt(harness: TestHarness): AgentExt | undefined {
  return getStateExtensions(harness).find((e) => e.kind === 'hook' && e.name === 'sonar-secrets');
}

/** Finds the `sonar-prompt-secrets` instructions extension in state, or `undefined` if absent. */
export function findSonarInstructionsExt(harness: TestHarness): AgentExt | undefined {
  return getStateExtensions(harness).find(
    (e) => e.kind === 'instructions' && e.name === 'sonar-prompt-secrets',
  );
}

/** Finds the `sonar-sqaa` instructions extension in state, or `undefined` if absent. */
export function findSonarSqaaInstructionsExt(harness: TestHarness): AgentExt | undefined {
  return getStateExtensions(harness).find(
    (e) => e.kind === 'instructions' && e.name === 'sonar-sqaa',
  );
}

/** Simulates a previous `sonar integrate copilot -g` run on disk. */
export function writeExistingGlobalHook(harness: TestHarness): void {
  const scriptRel = `.copilot/hooks/sonar-secrets/build-scripts/${PRETOOL_SECRETS_SCRIPT}`;
  harness.userHome.writeFile(scriptRel, '#!/bin/bash\nexit 0\n');
  const absScriptPath = harness.userHome.file(scriptRel).path;
  const hooksJson: CopilotHooksJson = {
    version: 1,
    hooks: { preToolUse: [makeHookEntry(normalizePath(absScriptPath))] },
  };
  harness.userHome.writeFile('.copilot/hooks/hooks.json', JSON.stringify(hooksJson));
}

/** Simulates a pre-existing global instructions file. */
export function writeExistingGlobalInstructions(harness: TestHarness): void {
  harness.userHome.writeFile(
    '.copilot/instructions/sonarqube.instructions.md',
    '# pre-existing global instructions\n',
  );
}

/**
 * Force the project-level hook configuration update to fail by pre-creating
 * `hooks.json` as a directory.
 */
export function obstructHooksJson(harness: TestHarness): void {
  mkdirSync(harness.cwd.file('.github', 'hooks').path, { recursive: true });
  mkdirSync(harness.cwd.file(...PROJECT_HOOKS_JSON_PATH).path);
}

/**
 * Force the project-level instructions write to fail by pre-creating the
 * target file path as a directory.
 */
export function obstructInstructionsFile(harness: TestHarness): void {
  mkdirSync(harness.cwd.file('.github', 'instructions').path, { recursive: true });
  mkdirSync(harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).path);
}
