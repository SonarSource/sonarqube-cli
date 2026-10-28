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

// Public hosts of the platforms `sonar import` binds today: GitHub and Azure DevOps.
const BINDABLE_HOSTS = new Set(['github.com', 'dev.azure.com', 'ssh.dev.azure.com']);
const AZURE_LEGACY_HOST_SUFFIX = '.visualstudio.com';
const SCP_LIKE_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.*)$/;
const AZURE_REMOTE_PATH = /^\/(?:v3\/)?[^/]+\/([^/]+)\/_git\/([^/]+)$/;
const GIT_SUFFIX = /\.git$/;

function remoteHostname(remote: string): string | null {
  const scpLike = SCP_LIKE_REMOTE.exec(remote);
  if (scpLike) {
    return scpLike[1].toLowerCase();
  }
  try {
    return new URL(remote).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Whether the remote is on a platform `sonar import` can bind. Self-hosted instances are not recognized. */
export function isBindableRemote(remote: string): boolean {
  const hostname = remoteHostname(remote);
  return (
    hostname !== null &&
    (BINDABLE_HOSTS.has(hostname) || hostname.endsWith(AZURE_LEGACY_HOST_SUFFIX))
  );
}

/**
 * The repository slug `sonar import --repo` expects: `owner/repo` on GitHub, `project/repo` on
 * Azure DevOps. Null when the remote is not a recognized bindable one.
 */
export function remoteRepositorySlug(remote: string): string | null {
  if (!isBindableRemote(remote)) {
    return null;
  }
  const scpLike = SCP_LIKE_REMOTE.exec(remote);
  let path: string;
  try {
    path = scpLike ? `/${scpLike[2]}` : new URL(remote).pathname;
  } catch {
    return null;
  }
  path = path.replace(GIT_SUFFIX, '');
  if (remoteHostname(remote) === 'dev.azure.com') {
    const match = AZURE_REMOTE_PATH.exec(path);
    return match ? `${match[1]}/${match[2]}` : null;
  }
  const parts = path.split('/').filter(Boolean);
  return parts.length === 2 ? parts.join('/') : null;
}
