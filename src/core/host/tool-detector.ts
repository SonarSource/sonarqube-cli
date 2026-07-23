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

import { spawnProcess } from '../../lib/process.ts';
import { isWindows } from './platform-detector.ts';

const CONTAINER_RUNTIMES = ['docker', 'podman', 'nerdctl'] as const;
export type ContainerRuntime = (typeof CONTAINER_RUNTIMES)[number];

const WSL_EXECUTABLE = 'wsl.exe';

async function isRuntimeAvailable(runtime: ContainerRuntime): Promise<boolean> {
  try {
    const result = await spawnProcess(runtime, ['info']);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function isRuntimeAvailableViaWsl(runtime: ContainerRuntime): Promise<boolean> {
  try {
    const result = await spawnProcess(WSL_EXECUTABLE, [runtime, 'info']); // only support the default distro
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export interface ContainerRuntimeDetection {
  runtime: ContainerRuntime | null;
  viaWsl: boolean;
}

/**
 * Detect the first available container runtime, checking in priority order:
 * docker, then podman, then nerdctl. On Windows, falls back to checking the same
 * runtimes from inside WSL when none is reachable natively (e.g. Docker installed
 * in a WSL distro without Docker Desktop's Windows integration).
 */
export async function detectContainerRuntime(): Promise<ContainerRuntimeDetection> {
  for (const runtime of CONTAINER_RUNTIMES) {
    if (await isRuntimeAvailable(runtime)) {
      return { runtime, viaWsl: false };
    }
  }

  if (isWindows()) {
    for (const runtime of CONTAINER_RUNTIMES) {
      if (await isRuntimeAvailableViaWsl(runtime)) {
        return { runtime, viaWsl: true };
      }
    }
  }

  return { runtime: null, viaWsl: false };
}
