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

import { INVOCATION_ID } from '@/core/telemetry/invocation-id.ts';

import { buildSubprocessNetworkEnv } from '../../lib/connectivity/network-config.ts';

export interface ContextAugmentationEnvContext {
  organization?: string;
  projectKey?: string;
  serverUrl?: string;
  token?: string;
  /**
   * Workspace root passed to CAG for its per-workspace daemon folder: the git
   * working-tree root containing the invocation (climbing up from subdirs), or
   * the physical integrate target when not in a git repo. Set only when a
   * recorded integration matched.
   */
  workspaceDir?: string;
}

type ContextAugmentationEnvKey =
  | 'SONAR_CONTEXT_ORGANIZATION'
  | 'SONAR_CONTEXT_PROJECT'
  | 'SONAR_CONTEXT_TOKEN'
  | 'SONAR_CONTEXT_URL'
  | 'SONAR_CONTEXT_WORKSPACE_ROOT';

/**
 * Build the env passed to sonar-context-augmentation subprocesses.
 *
 * - Called with no argument: parent SONAR_CONTEXT_* env passes through unchanged.
 * - Called with a context object: missing fields are unset (deleted), not inherited
 *   from the parent env. This prevents mixed contexts where e.g. an explicit token
 *   from active auth would otherwise be paired with an inherited project key.
 *
 * Always sets SONAR_CONTEXT_INVOCATION_ID to the per-CLI-process INVOCATION_ID
 * so the CAG client forwards it to the daemon (x-sonar-invocation-id header)
 * and telemetry can correlate CLI and daemon-side events.
 */
export function buildContextAugmentationEnv(
  context?: ContextAugmentationEnvContext,
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...buildSubprocessNetworkEnv() };
  env.SONAR_CONTEXT_INVOCATION_ID = INVOCATION_ID;
  if (context === undefined) {
    return env;
  }

  // A context object fully determines the SONAR_CONTEXT_* values. Clear any
  // inherited from the parent env first (static literal deletes — the dynamic
  // form trips @typescript-eslint/no-dynamic-delete), then set only the fields
  // provided so e.g. an explicit token is never paired with an inherited key.
  delete env.SONAR_CONTEXT_ORGANIZATION;
  delete env.SONAR_CONTEXT_PROJECT;
  delete env.SONAR_CONTEXT_TOKEN;
  delete env.SONAR_CONTEXT_URL;
  delete env.SONAR_CONTEXT_WORKSPACE_ROOT;

  assignContextEnvValue(env, 'SONAR_CONTEXT_ORGANIZATION', context.organization);
  assignContextEnvValue(env, 'SONAR_CONTEXT_PROJECT', context.projectKey);
  assignContextEnvValue(env, 'SONAR_CONTEXT_TOKEN', context.token);
  assignContextEnvValue(env, 'SONAR_CONTEXT_URL', context.serverUrl);
  assignContextEnvValue(env, 'SONAR_CONTEXT_WORKSPACE_ROOT', context.workspaceDir);

  return env;
}

function assignContextEnvValue(
  env: NodeJS.ProcessEnv,
  key: ContextAugmentationEnvKey,
  value: string | undefined,
): void {
  if (value !== undefined && value.length > 0) {
    env[key] = value;
  }
}
