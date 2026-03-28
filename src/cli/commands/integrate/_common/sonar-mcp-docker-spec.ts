/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

/**
 * Shared Docker `run … mcp/sonarqube` invocation for Claude (.claude.json) and Codex (config.toml).
 */

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { normalizePath } from '../../../../lib/fs-utils';

export interface SonarMcpDockerServerSpec {
  command: 'docker';
  args: string[];
  env: Record<string, string>;
}

export function buildSonarMcpDockerSpec(
  auth: ResolvedAuth,
  isGlobal: boolean,
  projectRoot: string,
  projectKey: string | undefined,
): SonarMcpDockerServerSpec {
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

  if (!isGlobal) {
    const hostPath = normalizePath(projectRoot);
    if (projectKey) {
      args.push('-e', 'SONARQUBE_PROJECT_KEY');
      env.SONARQUBE_PROJECT_KEY = projectKey;
    }
    args.push('-v', `${hostPath}:/app/mcp-workspace:ro`);
  }

  args.push('mcp/sonarqube');

  return { command: 'docker', args, env };
}
