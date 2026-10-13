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

import type { ResolvedAuth } from '../auth/auth-resolver.ts';
import { getGitRemote } from '../host/git/discover.ts';
import logger from '../observability/logger.ts';
import { formatConfigFields, selectValidServerUrl } from '../project-discovery-format.ts';
import type { DiscoveredProject, DiscoverProjectOptions } from '../project-info.ts';
import { SonarHttpClient } from './http-client.ts';
import { ProjectBindingsClient } from './project-bindings.ts';

export const GIT_REMOTE_BINDING_SOURCE = 'git remote (origin)';

export interface GitRemoteBindingDiscovery {
  projectKey: string;
  serverUrl: string;
  organization?: string;
}

/**
 * Resolves a SonarQube project key from the git origin remote URL via the server project-bindings API
 */
export function discoverProjectKeyByGitRemote(
  auth: ResolvedAuth,
  gitRemote: string,
): Promise<GitRemoteBindingDiscovery | null> {
  const client = new ProjectBindingsClient(new SonarHttpClient(auth.serverUrl, auth.token));
  return client.getProjectKeyByGitRemote(gitRemote, auth.orgKey).match(
    (projectKey) =>
      projectKey
        ? {
            projectKey,
            serverUrl: auth.serverUrl,
            organization: auth.orgKey,
          }
        : null,
    (error) => {
      logger.debug(`Git remote project binding lookup failed: ${error.message}`);
      return null;
    },
  );
}

/** A single repo-level last resort for discoverProjects(): never climbs, only ever consults the repo root's own origin remote. */
export async function applyGitRemoteBinding(
  config: DiscoveredProject,
  repoRoot: string | undefined,
  options: DiscoverProjectOptions,
): Promise<void> {
  if (options.auth === null) {
    return;
  }

  const gitRemote = repoRoot ? await getGitRemote(repoRoot) : '';
  if (!gitRemote) {
    return;
  }

  const auth = options.auth ?? null;
  if (!auth) {
    return;
  }

  const remoteBinding = await discoverProjectKeyByGitRemote(auth, gitRemote);
  if (!remoteBinding) {
    return;
  }

  config.configSources.push(GIT_REMOTE_BINDING_SOURCE);
  config.serverUrl = selectValidServerUrl(config.serverUrl, remoteBinding.serverUrl);
  config.projectKey = remoteBinding.projectKey;
  config.organization = config.organization || remoteBinding.organization;

  if (options.silent) {
    return;
  }

  const fields = formatConfigFields(config.serverUrl, config.projectKey, config.organization);
  if (fields) {
    options.console.print(`Found ${GIT_REMOTE_BINDING_SOURCE}: ${fields}`);
  }
}
