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

/**
 * Strip embedded credentials from a git remote URL before sending it to SonarQube.
 * HTTPS remotes may include userinfo (e.g. https://user:token@host/...); those must not
 * appear in server request logs.
 */
export function stripGitRemoteUrlUserinfo(remoteUrl: string): string {
  try {
    const parsed = new URL(remoteUrl);
    if (!parsed.username && !parsed.password) {
      return remoteUrl;
    }
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // SCP-style remotes (git@host:path) and other non-URL forms are returned unchanged.
    return remoteUrl;
  }
}
