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

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import * as process from '@/lib/process.ts';

// Mock platform-detector so both Windows and non-Windows branches are reachable on any OS.
const platformDetector = await import('@/core/host/platform-detector.ts');
const isWindowsMock = mock(() => false);
void mock.module('@/core/host/platform-detector.ts', () => ({
  ...platformDetector,
  isWindows: isWindowsMock,
}));

const { detectContainerRuntime } = await import('@/core/host/tool-detector.ts');

describe('detectContainerRuntime', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    spawnSpy.mockRestore();
    isWindowsMock.mockReset();
    isWindowsMock.mockImplementation(() => false);
  });

  it('returns "docker" when docker is available', async () => {
    spawnSpy = spyOn(process, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    expect(await detectContainerRuntime()).toEqual({ runtime: 'docker', viaWsl: false });
    expect(spawnSpy).toHaveBeenCalledWith('docker', ['info']);
  });

  it('returns "podman" when docker is unavailable but podman is available', async () => {
    spawnSpy = spyOn(process, 'spawnProcess').mockImplementation((cmd: string, _args: string[]) => {
      if (cmd === 'docker') {
        return Promise.reject(new Error('spawn docker ENOENT'));
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    expect(await detectContainerRuntime()).toEqual({ runtime: 'podman', viaWsl: false });
    expect(spawnSpy).toHaveBeenCalledWith('docker', ['info']);
    expect(spawnSpy).toHaveBeenCalledWith('podman', ['info']);
  });

  it('returns "nerdctl" when docker and podman are unavailable but nerdctl is available', async () => {
    spawnSpy = spyOn(process, 'spawnProcess').mockImplementation((cmd: string, _args: string[]) => {
      if (cmd === 'nerdctl') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      return Promise.reject(new Error(`spawn ${cmd} ENOENT`));
    });

    expect(await detectContainerRuntime()).toEqual({ runtime: 'nerdctl', viaWsl: false });
    expect(spawnSpy).toHaveBeenCalledWith('docker', ['info']);
    expect(spawnSpy).toHaveBeenCalledWith('podman', ['info']);
    expect(spawnSpy).toHaveBeenCalledWith('nerdctl', ['info']);
  });

  it('returns null when no container runtime is available and not on Windows', async () => {
    isWindowsMock.mockImplementation(() => false);
    spawnSpy = spyOn(process, 'spawnProcess').mockRejectedValue(new Error('ENOENT'));

    expect(await detectContainerRuntime()).toEqual({ runtime: null, viaWsl: false });
    expect(spawnSpy).not.toHaveBeenCalledWith('wsl.exe', expect.anything());
  });

  it('returns "docker" when docker daemon is running even if other runtimes are also available', async () => {
    spawnSpy = spyOn(process, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    expect(await detectContainerRuntime()).toEqual({ runtime: 'docker', viaWsl: false });
    // Should not have checked podman/nerdctl since docker succeeded
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when all runtime daemons are not running and not on Windows', async () => {
    isWindowsMock.mockImplementation(() => false);
    spawnSpy = spyOn(process, 'spawnProcess').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Cannot connect to daemon',
    });

    expect(await detectContainerRuntime()).toEqual({ runtime: null, viaWsl: false });
  });

  it('falls back to WSL when no native runtime is available on Windows', async () => {
    isWindowsMock.mockImplementation(() => true);
    spawnSpy = spyOn(process, 'spawnProcess').mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'wsl.exe' && args[0] === 'docker') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      return Promise.reject(new Error('ENOENT'));
    });

    expect(await detectContainerRuntime()).toEqual({ runtime: 'docker', viaWsl: true });
    expect(spawnSpy).toHaveBeenCalledWith('wsl.exe', ['docker', 'info']);
  });

  it('falls through to nerdctl via WSL when native and earlier WSL runtimes are unavailable', async () => {
    isWindowsMock.mockImplementation(() => true);
    spawnSpy = spyOn(process, 'spawnProcess').mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'wsl.exe' && args[0] === 'nerdctl') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      return Promise.reject(new Error('ENOENT'));
    });

    expect(await detectContainerRuntime()).toEqual({ runtime: 'nerdctl', viaWsl: true });
    expect(spawnSpy).toHaveBeenCalledWith('docker', ['info']);
    expect(spawnSpy).toHaveBeenCalledWith('podman', ['info']);
    expect(spawnSpy).toHaveBeenCalledWith('nerdctl', ['info']);
    expect(spawnSpy).toHaveBeenCalledWith('wsl.exe', ['docker', 'info']);
    expect(spawnSpy).toHaveBeenCalledWith('wsl.exe', ['podman', 'info']);
    expect(spawnSpy).toHaveBeenCalledWith('wsl.exe', ['nerdctl', 'info']);
  });

  it('returns null when neither a native nor a WSL runtime is available on Windows', async () => {
    isWindowsMock.mockImplementation(() => true);
    spawnSpy = spyOn(process, 'spawnProcess').mockRejectedValue(new Error('ENOENT'));

    expect(await detectContainerRuntime()).toEqual({ runtime: null, viaWsl: false });
  });
});
