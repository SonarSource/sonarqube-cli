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

// Tool detector - checks presence and availability of system tools

import { spawnProcess, spawnProcessWithTimeout } from '../../process/process.ts';
import { isWindows } from './platform-detector.ts';

const CONTAINER_RUNTIMES = ['docker', 'podman', 'nerdctl'] as const;
export type ContainerRuntime = (typeof CONTAINER_RUNTIMES)[number];

const WSL_EXECUTABLE = 'wsl.exe';
const RUNTIME_PROBE_TIMEOUT_MS = 3000;
const RUNTIME_PROBE_TIMEOUT_MESSAGE = 'Container runtime probe timed out';

type RuntimeProbeResult = 'ready' | 'failed' | 'timed_out';

async function probeRuntime(
  runtime: ContainerRuntime,
  viaWsl: boolean,
  args: string[],
): Promise<RuntimeProbeResult> {
  const command = viaWsl ? WSL_EXECUTABLE : runtime;
  try {
    const result = await spawnProcessWithTimeout(
      command,
      viaWsl ? [runtime, ...args] : args,
      {},
      RUNTIME_PROBE_TIMEOUT_MS,
      RUNTIME_PROBE_TIMEOUT_MESSAGE,
    );
    return result.exitCode === 0 ? 'ready' : 'failed';
  } catch (error) {
    return error instanceof Error && error.message === RUNTIME_PROBE_TIMEOUT_MESSAGE
      ? 'timed_out'
      : 'failed';
  }
}

export type ContainerRuntimeHealth =
  | { status: 'ready'; runtime: ContainerRuntime; viaWsl: boolean }
  | { status: 'unavailable'; runtime: ContainerRuntime; viaWsl: boolean; reason?: 'timeout' }
  | { status: 'missing' };

export interface ContainerRuntimeDetection {
  runtime: ContainerRuntime | null;
  viaWsl: boolean;
}

async function isRuntimeAvailable(runtime: ContainerRuntime, viaWsl: boolean): Promise<boolean> {
  try {
    const command = viaWsl ? WSL_EXECUTABLE : runtime;
    const args = viaWsl ? [runtime, 'info'] : ['info'];
    return (await spawnProcess(command, args)).exitCode === 0;
  } catch {
    return false;
  }
}

async function probeRuntimeSet(viaWsl: boolean): Promise<ContainerRuntimeHealth> {
  for (const runtime of CONTAINER_RUNTIMES) {
    const result = await probeRuntime(runtime, viaWsl, ['info']);
    if (result === 'ready') return { status: 'ready', runtime, viaWsl };
    if (result === 'timed_out') {
      return { status: 'unavailable', runtime, viaWsl, reason: 'timeout' };
    }
  }
  const installed = await Promise.all(
    CONTAINER_RUNTIMES.map((runtime) => probeRuntime(runtime, viaWsl, ['--version'])),
  );
  const installedIndex = installed.indexOf('ready');
  return installedIndex >= 0
    ? { status: 'unavailable', runtime: CONTAINER_RUNTIMES[installedIndex], viaWsl }
    : { status: 'missing' };
}

export async function checkContainerRuntimeHealth(): Promise<ContainerRuntimeHealth> {
  const native = await probeRuntimeSet(false);
  if (native.status === 'ready' || !isWindows()) return native;
  if (native.status === 'unavailable' && native.reason === 'timeout') return native;
  const viaWsl = await probeRuntimeSet(true);
  if (viaWsl.status === 'ready') return viaWsl;
  return native.status === 'unavailable' ? native : viaWsl;
}

/**
 * Detect the first available container runtime, checking in priority order:
 * docker, then podman, then nerdctl. On Windows, falls back to checking the same
 * runtimes from inside WSL when none is reachable natively (e.g. Docker installed
 * in a WSL distro without Docker Desktop's Windows integration).
 */
export async function detectContainerRuntime(): Promise<ContainerRuntimeDetection> {
  for (const runtime of CONTAINER_RUNTIMES) {
    if (await isRuntimeAvailable(runtime, false)) {
      return { runtime, viaWsl: false };
    }
  }

  if (isWindows()) {
    for (const runtime of CONTAINER_RUNTIMES) {
      if (await isRuntimeAvailable(runtime, true)) {
        return { runtime, viaWsl: true };
      }
    }
  }

  return { runtime: null, viaWsl: false };
}
