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

import logger from '../../lib/logger.ts';
import type { ResolvedAuth } from './auth-resolver.ts';
import { SonarQubeClient } from './client.ts';

export const GIT_REMOTE_BINDING_SOURCE = 'git remote (origin)';

export interface GitRemoteBindingDiscovery {
  projectKey: string;
  serverUrl: string;
  organization?: string;
}

/**
 * Resolves a SonarQube project key from the git origin remote URL via the server project-bindings API
 */
export async function discoverProjectKeyByGitRemote(
  auth: ResolvedAuth,
  gitRemote: string,
): Promise<GitRemoteBindingDiscovery | null> {
  try {
    const client = new SonarQubeClient(auth.serverUrl, auth.token);
    const projectKey = await client.getProjectKeyByGitRemote(gitRemote, auth.orgKey);
    if (!projectKey) {
      return null;
    }
    return {
      projectKey,
      serverUrl: auth.serverUrl,
      organization: auth.orgKey,
    };
  } catch (error) {
    logger.debug(`Git remote project binding lookup failed: ${(error as Error).message}`);
    return null;
  }
}
