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

import { hookScriptName, IS_WINDOWS, normalizePath, TestHarness } from '../../harness';
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

export const PROJECT_INSTRUCTIONS_PATH = [
  '.agents',
  'instructions',
  'sonarqube.instructions.md',
] as const;

export const GLOBAL_INSTRUCTIONS_PATH = [
  '.gemini',
  'config',
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

export function makeAntigravitySecretsBlock(command: string): AntigravityHooksJson {
  return {
    'sonar-secrets': {
      enabled: true,
      PreToolUse: [
        {
          matcher: 'view_file',
          hooks: [{ type: 'command', command, timeout: 60 }],
        },
      ],
    },
  };
}

/** Simulates a previous global Antigravity secrets hook install on disk. */
export function writeExistingGlobalHook(harness: TestHarness): void {
  const scriptRel = join('.gemini', 'config', 'sonar', 'hooks', PRETOOL_SECRETS_SCRIPT);
  harness.userHome.writeFile(scriptRel, '#!/bin/bash\nexit 0\n');
  const absScriptPath = normalizePath(join(harness.userHome.path, scriptRel));
  const command = IS_WINDOWS
    ? `powershell -NoProfile -File "${absScriptPath}"`
    : `bash "${absScriptPath}"`;
  harness.userHome.writeFile(
    join('.gemini', 'config', 'hooks.json'),
    JSON.stringify(makeAntigravitySecretsBlock(command)),
  );
}

/** Simulates a disabled global sonar-secrets block (hook entry present but not active). */
export function writeDisabledGlobalHook(harness: TestHarness): void {
  const scriptRel = join('.gemini', 'config', 'sonar', 'hooks', PRETOOL_SECRETS_SCRIPT);
  harness.userHome.writeFile(scriptRel, '#!/bin/bash\nexit 0\n');
  const absScriptPath = normalizePath(join(harness.userHome.path, scriptRel));
  const command = IS_WINDOWS
    ? `powershell -NoProfile -File "${absScriptPath}"`
    : `bash "${absScriptPath}"`;
  harness.userHome.writeFile(
    join('.gemini', 'config', 'hooks.json'),
    JSON.stringify({
      'sonar-secrets': {
        enabled: false,
        PreToolUse: [
          {
            matcher: 'view_file',
            hooks: [{ type: 'command', command, timeout: 60 }],
          },
        ],
      },
    }),
  );
}

/** Simulates a pre-existing global instructions file. */
export function writeExistingGlobalInstructions(harness: TestHarness): void {
  harness.userHome.writeFile(
    join('.gemini', 'config', 'instructions', 'sonarqube.instructions.md'),
    '# pre-existing global instructions\n',
  );
}

/** Simulates a global hooks.json entry whose backing script file was removed. */
export function writeOrphanedGlobalHookConfig(harness: TestHarness): void {
  const scriptRel = join('.gemini', 'config', 'sonar', 'hooks', PRETOOL_SECRETS_SCRIPT);
  const absScriptPath = normalizePath(join(harness.userHome.path, scriptRel));
  const command = IS_WINDOWS
    ? `powershell -NoProfile -File "${absScriptPath}"`
    : `bash "${absScriptPath}"`;
  harness.userHome.writeFile(
    join('.gemini', 'config', 'hooks.json'),
    JSON.stringify(makeAntigravitySecretsBlock(command)),
  );
}
