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
import { spawnProcessWithTimeout, type SpawnResult } from '../../../../lib/process.ts';
import { type ScaScannerSpawner } from './sca-scanner-spawner.ts';

const ThreeMinuteTimeoutMs = 3 * 60 * 1000;

export class DefaultScaScannerSpawner implements ScaScannerSpawner {
  spawn(binaryPath: string, args: string[]): Promise<SpawnResult> {
    return spawnProcessWithTimeout(
      binaryPath,
      args,
      { stdout: 'pipe', stderr: 'pipe' },
      ThreeMinuteTimeoutMs,
      'Dependency Risk scanner timed out',
    );
  }
}
