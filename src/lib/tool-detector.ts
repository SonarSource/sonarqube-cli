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

// Tool detector - checks presence and availability of system tools

import { spawnProcess } from './process';

/**
 * Check if Docker is installed and its daemon is running.
 * Returns true only when both conditions hold — a false result means either
 * the `docker` binary is not on PATH or the daemon is not reachable.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    // `docker info` exits 0 only when the daemon is reachable.
    const result = await spawnProcess('docker', ['info']);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
