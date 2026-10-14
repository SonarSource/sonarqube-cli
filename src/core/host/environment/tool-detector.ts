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

import { spawnProcessWithTimeout } from '../../process/process.ts';
import { isWindows } from './platform-detector.ts';

const CONTAINER_RUNTIMES = ['docker', 'podman', 'nerdctl'] as const;
export type ContainerRuntime = (typeof CONTAINER_RUNTIMES)[number];

const WSL_EXECUTABLE = 'wsl.exe';
const RUNTIME_PROBE_TIMEOUT_MS = 3000;

async function probeRuntime(
  runtime: ContainerRuntime,
  viaWsl: boolean,
  args: string[],
): Promise<boolean> {
  const command = viaWsl ? WSL_EXECUTABLE : runtime;
  try {
    const result = await spawnProcessWithTimeout(
      command,
      viaWsl ? [runtime, ...args] : args,
      {},
      RUNTIME_PROBE_TIMEOUT_MS,
      'Container runtime probe timed out',
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export type ContainerRuntimeHealth =
  | { status: 'ready'; runtime: ContainerRuntime; viaWsl: boolean }
  | { status: 'unavailable'; runtime: ContainerRuntime; viaWsl: boolean }
  | { status: 'missing' };

export interface ContainerRuntimeDetection {
  runtime: ContainerRuntime | null;
  viaWsl: boolean;
}

async function probeRuntimeSet(viaWsl: boolean): Promise<ContainerRuntimeHealth> {
  const ready = await Promise.all(
    CONTAINER_RUNTIMES.map((runtime) => probeRuntime(runtime, viaWsl, ['info'])),
  );
  const readyIndex = ready.findIndex(Boolean);
  if (readyIndex >= 0) {
    return { status: 'ready', runtime: CONTAINER_RUNTIMES[readyIndex], viaWsl };
  }
  const installed = await Promise.all(
    CONTAINER_RUNTIMES.map((runtime) => probeRuntime(runtime, viaWsl, ['--version'])),
  );
  const installedIndex = installed.findIndex(Boolean);
  return installedIndex >= 0
    ? { status: 'unavailable', runtime: CONTAINER_RUNTIMES[installedIndex], viaWsl }
    : { status: 'missing' };
}

export async function checkContainerRuntimeHealth(): Promise<ContainerRuntimeHealth> {
  const native = await probeRuntimeSet(false);
  if (native.status === 'ready' || !isWindows()) return native;
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
  const health = await checkContainerRuntimeHealth();
  return health.status === 'ready'
    ? { runtime: health.runtime, viaWsl: health.viaWsl }
    : { runtime: null, viaWsl: false };
}
