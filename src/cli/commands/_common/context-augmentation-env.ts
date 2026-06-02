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

export interface ContextAugmentationEnvContext {
  organization?: string;
  projectKey?: string;
  serverUrl?: string;
  token?: string;
}

type ContextAugmentationEnvKey =
  | 'SONAR_CONTEXT_ORGANIZATION'
  | 'SONAR_CONTEXT_PROJECT'
  | 'SONAR_CONTEXT_TOKEN'
  | 'SONAR_CONTEXT_URL';

/**
 * Build the env passed to sonar-context-augmentation subprocesses.
 *
 * - Called with no argument: parent SONAR_CONTEXT_* env passes through unchanged.
 * - Called with a context object: missing fields are unset (deleted), not inherited
 *   from the parent env. This prevents mixed contexts where e.g. an explicit token
 *   from active auth would otherwise be paired with an inherited project key.
 */
export function buildContextAugmentationEnv(
  context?: ContextAugmentationEnvContext,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (context === undefined) {
    return env;
  }

  setContextEnvValue(env, 'SONAR_CONTEXT_ORGANIZATION', context.organization);
  setContextEnvValue(env, 'SONAR_CONTEXT_PROJECT', context.projectKey);
  setContextEnvValue(env, 'SONAR_CONTEXT_TOKEN', context.token);
  setContextEnvValue(env, 'SONAR_CONTEXT_URL', context.serverUrl);

  return env;
}

function setContextEnvValue(
  env: NodeJS.ProcessEnv,
  key: ContextAugmentationEnvKey,
  value: string | undefined,
): void {
  if (value !== undefined && value.length > 0) {
    env[key] = value;
    return;
  }

  // Explicit per-key delete: @typescript-eslint/no-dynamic-delete forbids `delete env[key]`.
  switch (key) {
    case 'SONAR_CONTEXT_ORGANIZATION':
      delete env.SONAR_CONTEXT_ORGANIZATION;
      return;
    case 'SONAR_CONTEXT_PROJECT':
      delete env.SONAR_CONTEXT_PROJECT;
      return;
    case 'SONAR_CONTEXT_TOKEN':
      delete env.SONAR_CONTEXT_TOKEN;
      return;
    case 'SONAR_CONTEXT_URL':
      delete env.SONAR_CONTEXT_URL;
      return;
  }
}
