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

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import logger from '@/core/observability/logger.ts';
import * as processModule from '@/core/process/process.ts';

// Mock platform-detector so both Windows and non-Windows branches are reachable on any OS.
const platformDetector = await import('@/core/host/environment/platform-detector.ts');
const isWindowsMock = mock(() => false);
void mock.module('@/core/host/environment/platform-detector.ts', () => ({
  ...platformDetector,
  isWindows: isWindowsMock,
}));

const { detectContainerRuntime } = await import('@/core/host/environment/tool-detector.ts');
const missingRuntime = () => Object.assign(new Error('Executable not found'), { code: 'ENOENT' });

describe('detectContainerRuntime', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  const originalWslMode = process.env.SONARQUBE_CLI_MCP_WSL;
  const originalLegacyWslMode = process.env.SONAR_MCP_WSL;

  beforeEach(() => {
    delete process.env.SONARQUBE_CLI_MCP_WSL;
    delete process.env.SONAR_MCP_WSL;
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    isWindowsMock.mockReset();
    isWindowsMock.mockImplementation(() => false);
    if (originalWslMode === undefined) delete process.env.SONARQUBE_CLI_MCP_WSL;
    else process.env.SONARQUBE_CLI_MCP_WSL = originalWslMode;
    if (originalLegacyWslMode === undefined) delete process.env.SONAR_MCP_WSL;
    else process.env.SONAR_MCP_WSL = originalLegacyWslMode;
  });

  it('returns "docker" when docker is available', async () => {
    spawnSpy = spyOn(processModule, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    expect(await detectContainerRuntime()).toEqual({ runtime: 'docker', viaWsl: false });
    expect(spawnSpy).toHaveBeenCalledWith('docker', ['info']);
  });

  it('returns "podman" when docker is unavailable but podman is available', async () => {
    spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      (cmd: string, _args: string[]) => {
        if (cmd === 'docker') {
          return Promise.reject(missingRuntime());
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
    );

    expect(await detectContainerRuntime()).toEqual({ runtime: 'podman', viaWsl: false });
    expect(spawnSpy).toHaveBeenCalledWith('docker', ['info']);
    expect(spawnSpy).toHaveBeenCalledWith('podman', ['info']);
  });

  it('returns "nerdctl" when docker and podman are unavailable but nerdctl is available', async () => {
    spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      (cmd: string, _args: string[]) => {
        if (cmd === 'nerdctl') {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        return Promise.reject(missingRuntime());
      },
    );

    expect(await detectContainerRuntime()).toEqual({ runtime: 'nerdctl', viaWsl: false });
    expect(spawnSpy).toHaveBeenCalledWith('docker', ['info']);
    expect(spawnSpy).toHaveBeenCalledWith('podman', ['info']);
    expect(spawnSpy).toHaveBeenCalledWith('nerdctl', ['info']);
  });

  it('returns null when no container runtime is available and not on Windows', async () => {
    isWindowsMock.mockImplementation(() => false);
    spawnSpy = spyOn(processModule, 'spawnProcess').mockRejectedValue(missingRuntime());

    expect(await detectContainerRuntime()).toEqual({ runtime: null, viaWsl: false });
    expect(spawnSpy.mock.calls.map((call: unknown[]) => String(call[0]))).not.toContain('wsl.exe');
  });

  it('returns "docker" when docker daemon is running even if other runtimes are also available', async () => {
    spawnSpy = spyOn(processModule, 'spawnProcess').mockResolvedValue({
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
    spawnSpy = spyOn(processModule, 'spawnProcess').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Cannot connect to daemon',
    });

    expect(await detectContainerRuntime()).toEqual({ runtime: null, viaWsl: false });
  });

  it('falls back to WSL when no native runtime is available on Windows', async () => {
    isWindowsMock.mockImplementation(() => true);
    spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      (cmd: string, args: string[]) => {
        if (cmd === 'wsl.exe' && args[0] === 'docker') {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        return Promise.reject(missingRuntime());
      },
    );

    expect(await detectContainerRuntime()).toEqual({ runtime: 'docker', viaWsl: true });
    expect(spawnSpy).toHaveBeenCalledWith('wsl.exe', ['docker', 'info']);
  });

  it('falls through to nerdctl via WSL when native and earlier WSL runtimes are unavailable', async () => {
    isWindowsMock.mockImplementation(() => true);
    spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      (cmd: string, args: string[]) => {
        if (cmd === 'wsl.exe' && args[0] === 'nerdctl') {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        return Promise.reject(missingRuntime());
      },
    );

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
    spawnSpy = spyOn(processModule, 'spawnProcess').mockRejectedValue(missingRuntime());

    expect(await detectContainerRuntime()).toEqual({ runtime: null, viaWsl: false });
  });

  it.each([undefined, 'auto', '', '  ', ' Auto '])(
    'tries WSL when every native runtime is missing and SONARQUBE_CLI_MCP_WSL is %s',
    async (mode) => {
      isWindowsMock.mockImplementation(() => true);
      if (mode !== undefined) process.env.SONARQUBE_CLI_MCP_WSL = mode;
      else delete process.env.SONARQUBE_CLI_MCP_WSL;
      const logSpy = spyOn(logger, 'info').mockImplementation(() => undefined);
      spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation((cmd: string) =>
        cmd === 'wsl.exe'
          ? Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
          : Promise.reject(missingRuntime()),
      );
      try {
        expect(await detectContainerRuntime()).toEqual({ runtime: 'docker', viaWsl: true });
        expect(logSpy).toHaveBeenCalledWith(
          'No native container runtime found on Windows; trying WSL.',
        );
      } finally {
        logSpy.mockRestore();
      }
    },
  );

  it('keeps the native failure and does not start WSL in auto mode', async () => {
    isWindowsMock.mockImplementation(() => true);
    process.env.SONARQUBE_CLI_MCP_WSL = 'auto';
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => undefined);
    spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation((cmd: string) =>
      cmd === 'docker'
        ? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'Cannot reach daemon' })
        : Promise.reject(missingRuntime()),
    );
    try {
      expect(await detectContainerRuntime()).toEqual({
        runtime: null,
        viaWsl: false,
        nativeFailure: { runtime: 'docker', exitCode: 1, stderr: 'Cannot reach daemon' },
      });
      expect(spawnSpy.mock.calls.map((call: unknown[]) => String(call[0]))).not.toContain(
        'wsl.exe',
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not falling back to WSL'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logs a native spawn failure without an exit code', async () => {
    isWindowsMock.mockImplementation(() => true);
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => undefined);
    spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation((cmd: string) =>
      cmd === 'docker'
        ? Promise.reject(Object.assign(new Error('spawn docker EACCES'), { code: 'EACCES' }))
        : Promise.reject(missingRuntime()),
    );
    try {
      expect(await detectContainerRuntime()).toEqual({
        runtime: null,
        viaWsl: false,
        nativeFailure: { runtime: 'docker', exitCode: null, stderr: 'spawn docker EACCES' },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        'docker found on Windows but not reachable: spawn docker EACCES; not falling back to WSL.',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('uses a later native runtime when an earlier one is unreachable', async () => {
    isWindowsMock.mockImplementation(() => true);
    spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation((cmd: string) =>
      Promise.resolve({ exitCode: cmd === 'podman' ? 0 : 1, stdout: '', stderr: 'Unavailable' }),
    );

    expect(await detectContainerRuntime()).toEqual({ runtime: 'podman', viaWsl: false });
    expect(spawnSpy.mock.calls.map((call: unknown[]) => String(call[0]))).not.toContain('wsl.exe');
  });

  it.each(
    ['SONARQUBE_CLI_MCP_WSL', 'SONAR_MCP_WSL'].flatMap((name) =>
      ['always', 'Always', ' ALWAYS '].map((mode) => [name, mode]),
    ),
  )('uses only WSL with %s=%s', async (name, mode) => {
    isWindowsMock.mockImplementation(() => true);
    process.env[name] = mode;
    const logSpy = spyOn(logger, 'info').mockImplementation(() => undefined);
    spawnSpy = spyOn(processModule, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    try {
      expect(await detectContainerRuntime()).toEqual({ runtime: 'docker', viaWsl: true });
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy).toHaveBeenCalledWith('wsl.exe', ['docker', 'info']);
      expect(logSpy).toHaveBeenCalledWith(
        `${name}=always; checking container runtimes through WSL only.`,
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it.each(
    ['SONARQUBE_CLI_MCP_WSL', 'SONAR_MCP_WSL'].flatMap((name) =>
      ['never', ' never', 'NEVER '].map((mode) => [name, mode]),
    ),
  )('never starts WSL with %s=%s', async (name, mode) => {
    isWindowsMock.mockImplementation(() => true);
    process.env[name] = mode;
    const logSpy = spyOn(logger, 'info').mockImplementation(() => undefined);
    spawnSpy = spyOn(processModule, 'spawnProcess').mockRejectedValue(missingRuntime());

    try {
      expect(await detectContainerRuntime()).toEqual({ runtime: null, viaWsl: false });
      expect(spawnSpy.mock.calls.map((call: unknown[]) => String(call[0]))).not.toContain(
        'wsl.exe',
      );
      expect(logSpy).toHaveBeenCalledWith(`${name}=never; WSL will not be checked.`);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('identifies a failed WSL-only search', async () => {
    isWindowsMock.mockImplementation(() => true);
    process.env.SONARQUBE_CLI_MCP_WSL = 'always';
    spawnSpy = spyOn(processModule, 'spawnProcess').mockRejectedValue(missingRuntime());
    expect(await detectContainerRuntime()).toEqual({ runtime: null, viaWsl: false, wslOnly: true });
    expect(spawnSpy.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
      'wsl.exe',
      'wsl.exe',
      'wsl.exe',
    ]);
  });

  it.each([
    ['  first\nsecond\nthird\nfourth\n', 'first\nsecond\nthird'],
    ['  ', 'No error output.'],
    ['x'.repeat(1001), 'x'.repeat(1000)],
  ])('bounds native runtime diagnostics for %s', async (stderr, expected) => {
    isWindowsMock.mockImplementation(() => true);
    spawnSpy = spyOn(processModule, 'spawnProcess').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr,
    });
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      expect((await detectContainerRuntime()).nativeFailure?.stderr).toBe(expected);
      expect(warnSpy).toHaveBeenCalledWith(
        `docker found on Windows but not reachable (exit 1): ${expected}; not falling back to WSL.`,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each([
    [undefined, 'always', true],
    ['never', 'always', false],
    ['always', 'never', true],
    ['', 'always', false],
    ['never', 'invalid', false],
  ] as const)(
    'selects the primary value %s before legacy value %s',
    async (primary, legacy, viaWsl) => {
      isWindowsMock.mockImplementation(() => true);
      if (primary !== undefined) process.env.SONARQUBE_CLI_MCP_WSL = primary;
      process.env.SONAR_MCP_WSL = legacy;
      spawnSpy = spyOn(processModule, 'spawnProcess').mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
      expect(await detectContainerRuntime()).toEqual({ runtime: 'docker', viaWsl });
      expect(spawnSpy.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
        viaWsl ? 'wsl.exe' : 'docker',
      ]);
    },
  );

  it.each(['SONARQUBE_CLI_MCP_WSL', 'SONAR_MCP_WSL'])(
    'rejects an invalid %s mode on Windows',
    async (name) => {
      isWindowsMock.mockImplementation(() => true);
      process.env[name] = 'sometimes';
      spawnSpy = spyOn(processModule, 'spawnProcess').mockRejectedValue(missingRuntime());

      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
      await expect(detectContainerRuntime()).rejects.toMatchObject({
        name: 'InvalidOptionError',
        message: `${name} must be auto, always, or never.`,
        exitCode: 2,
      });
      expect(spawnSpy).not.toHaveBeenCalled();
    },
  );

  it('ignores SONARQUBE_CLI_MCP_WSL outside Windows', async () => {
    process.env.SONARQUBE_CLI_MCP_WSL = 'sometimes';
    spawnSpy = spyOn(processModule, 'spawnProcess').mockRejectedValue(missingRuntime());

    expect(await detectContainerRuntime()).toEqual({ runtime: null, viaWsl: false });
    expect(spawnSpy.mock.calls.map((call: unknown[]) => String(call[0]))).not.toContain('wsl.exe');
  });
});
