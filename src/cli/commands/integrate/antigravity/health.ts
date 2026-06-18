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
import { dirname, isAbsolute, join } from 'node:path';

import {
  ANTIGRAVITY_GLOBAL_HOOKS_JSON,
  ANTIGRAVITY_PROJECT_HOOKS_JSON,
} from '../../../../lib/config-constants';
import {
  extractScriptPathFromHookCommand,
  hookReferencesSonarSecrets,
  isSonarSecretsPreToolUseEntry,
  SONAR_SECRETS_BLOCK_NAME,
  toAntigravityHooksDocument,
} from './hooks';

export type AntigravityIntegrationConfigStatus = 'configured' | 'invalid' | 'not_configured';

/** Resolve the hooks.json path for an installed Antigravity secrets-hook feature. */
export function resolveAntigravitySecretsHooksJsonPath(
  scope: 'project' | 'global',
  targetRoot: string,
): string {
  return scope === 'global'
    ? ANTIGRAVITY_GLOBAL_HOOKS_JSON
    : join(targetRoot, ANTIGRAVITY_PROJECT_HOOKS_JSON);
}

/**
 * Validate the on-disk Antigravity PreToolUse secrets hook (sonar-secrets block +
 * backing script). Used by `sonar system status` health reporting.
 */
export function checkAntigravitySecretsHookFile(
  hooksJsonPath: string,
): AntigravityIntegrationConfigStatus {
  if (!existsSync(hooksJsonPath)) {
    return 'not_configured';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')) as unknown;
  } catch {
    return 'invalid';
  }

  const document = toAntigravityHooksDocument(parsed);
  const block = document[SONAR_SECRETS_BLOCK_NAME];
  if (!block || block.enabled === false) {
    return 'not_configured';
  }

  const matchedEntry = block.PreToolUse?.find(isSonarSecretsPreToolUseEntry);
  if (!matchedEntry) {
    return 'invalid';
  }

  const command = matchedEntry.hooks.find((hook) =>
    hookReferencesSonarSecrets(hook.command),
  )?.command;
  if (!command) {
    return 'invalid';
  }

  const scriptPath = extractScriptPathFromHookCommand(command);
  if (!scriptPath) {
    return 'invalid';
  }

  // Project installs store paths relative to `.agents/` (Antigravity PreToolUse cwd).
  const resolvedScriptPath = isAbsolute(scriptPath)
    ? scriptPath
    : join(dirname(hooksJsonPath), scriptPath);
  if (!existsSync(resolvedScriptPath)) {
    return 'invalid';
  }

  return 'configured';
}
