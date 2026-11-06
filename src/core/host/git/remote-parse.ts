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

const SCP_LIKE_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.*)$/;
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
const GIT_SUFFIX = /\.git$/;

export interface GitRemote {
  /** Lowercased hostname, without user or port. */
  host: string;
  /** Always starts with `/`, with any `.git` suffix removed. */
  path: string;
}

/** HTTPS, SCP-style SSH (`[user@]host:path`) and SSH URLs of one repository give the same host and path. */
export function parseGitRemote(remote: string): GitRemote | null {
  const scpLike = WINDOWS_DRIVE_PATH.test(remote) ? null : SCP_LIKE_REMOTE.exec(remote);
  if (scpLike) {
    return { host: scpLike[1].toLowerCase(), path: `/${scpLike[2]}`.replace(GIT_SUFFIX, '') };
  }
  try {
    const url = new URL(remote);
    return url.hostname
      ? { host: url.hostname.toLowerCase(), path: url.pathname.replace(GIT_SUFFIX, '') }
      : null;
  } catch {
    return null;
  }
}
