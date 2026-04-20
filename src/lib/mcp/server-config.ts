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

import type { ResolvedAuth } from '../auth-resolver';
import { normalizePath } from '../fs-utils';
import type { ContainerRuntime } from '../tool-detector';

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface McpServerOptions {
  debug?: boolean;
  readOnly?: boolean;
  toolsets?: string;
}

export type McpServerContext =
  | { withFsMount: false; discoveredProjectKey?: string }
  | {
      withFsMount: true;
      projectRoot: string;
      discoveredProjectKey?: string;
    };

export function getMcpServerConfig(
  auth: ResolvedAuth,
  runtime: ContainerRuntime,
  context: McpServerContext,
  options: McpServerOptions = {},
): McpServerConfig {
  const { token, orgKey: org, serverUrl } = auth;

  const args = [
    'run',
    '--init',
    '--pull=always',
    '-i',
    '--rm',
    '-e',
    'SONARQUBE_TOKEN',
    '-e',
    'SONARQUBE_URL',
  ];
  const env: Record<string, string> = { SONARQUBE_TOKEN: token, SONARQUBE_URL: serverUrl };

  if (auth.connectionType === 'cloud') {
    args.push('-e', 'SONARQUBE_ORG');
    env.SONARQUBE_ORG = org ?? '';
  }

  if (context.discoveredProjectKey) {
    args.push('-e', 'SONARQUBE_PROJECT_KEY');
    env.SONARQUBE_PROJECT_KEY = context.discoveredProjectKey;
  }

  if (context.withFsMount) {
    const hostPath = normalizePath(context.projectRoot);
    args.push('-v', `${hostPath}:/app/mcp-workspace:ro`);
  }

  if (options.debug) {
    args.push('-e', 'SONARQUBE_DEBUG_ENABLED');
    env.SONARQUBE_DEBUG_ENABLED = 'true';
  }

  if (options.readOnly) {
    args.push('-e', 'SONARQUBE_READ_ONLY');
    env.SONARQUBE_READ_ONLY = 'true';
  }

  if (options.toolsets) {
    args.push('-e', 'SONARQUBE_TOOLSETS');
    env.SONARQUBE_TOOLSETS = options.toolsets;
  }

  args.push('mcp/sonarqube');

  return { command: runtime, args, env };
}
