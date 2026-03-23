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

import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import * as process from '../../src/lib/process';
import { isDockerAvailable } from '../../src/lib/tool-detector';

describe('isDockerAvailable', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('returns true when docker is available and daemon is running (exit code 0)', async () => {
    spawnSpy = spyOn(process, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    expect(await isDockerAvailable()).toBe(true);
    expect(spawnSpy).toHaveBeenCalledWith('docker', ['info']);
  });

  it('returns false when docker is installed but daemon is not running (non-zero exit code)', async () => {
    spawnSpy = spyOn(process, 'spawnProcess').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
    });

    expect(await isDockerAvailable()).toBe(false);
  });

  it('returns false when docker binary is not found (spawnProcess throws)', async () => {
    spawnSpy = spyOn(process, 'spawnProcess').mockRejectedValue(new Error('spawn docker ENOENT'));

    expect(await isDockerAvailable()).toBe(false);
  });
});
