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

import { parseGitRemote } from '@/core/host/git/remote-parse.ts';

// Public hosts of the platforms `sonar import` binds today: GitHub and Azure DevOps.
const GITHUB_HOST = 'github.com';
const AZURE_HOSTS = new Set(['dev.azure.com', 'ssh.dev.azure.com']);
const AZURE_LEGACY_HOST_SUFFIX = '.visualstudio.com';
// `<org>/<project>/_git/<repo>` on dev.azure.com, `[<collection>/]<project>/_git/<repo>` on the legacy
// host, `v3/<org>/<project>/<repo>` over SSH. The short `<org>/_git/<repo>` form names no project.
const AZURE_HTTPS_PATH = /^\/[^/]+\/([^/]+)\/_git\/([^/]+)$/;
const AZURE_LEGACY_PATH = /^\/(?:[^/]+\/)?([^/]+)\/_git\/([^/]+)$/;
const LEGACY_DEFAULT_COLLECTION = 'defaultcollection';
const AZURE_SSH_PATH = /^\/v3\/[^/]+\/([^/]+)\/([^/]+)$/;

function isAzureHost(host: string): boolean {
  return AZURE_HOSTS.has(host) || host.endsWith(AZURE_LEGACY_HOST_SUFFIX);
}

function isBindableHost(host: string): boolean {
  return host === GITHUB_HOST || isAzureHost(host);
}

/** Whether the remote is on a platform `sonar import` can bind. Self-hosted instances are not recognized. */
export function isBindableRemote(remote: string): boolean {
  const host = parseGitRemote(remote)?.host;
  return host !== undefined && isBindableHost(host);
}

/**
 * The repository slug `sonar import --repo` expects: `owner/repo` on GitHub, `project/repo` on
 * Azure DevOps. Null when the remote is not a recognized bindable one.
 */
export function remoteRepositorySlug(remote: string): string | null {
  const parsed = parseGitRemote(remote);
  if (!parsed || !isBindableHost(parsed.host)) {
    return null;
  }
  const { host, path } = parsed;
  if (isAzureHost(host)) {
    const pattern = host.endsWith(AZURE_LEGACY_HOST_SUFFIX) ? AZURE_LEGACY_PATH : AZURE_HTTPS_PATH;
    const match = pattern.exec(path) ?? AZURE_SSH_PATH.exec(path);
    if (!match || match[1].toLowerCase() === LEGACY_DEFAULT_COLLECTION) {
      return null;
    }
    return `${match[1]}/${match[2]}`;
  }
  const parts = path.split('/').filter(Boolean);
  return parts.length === 2 ? parts.join('/') : null;
}
