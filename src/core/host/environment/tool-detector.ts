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

import { InvalidOptionError } from '../../commands/command-error.ts';
import logger from '../../observability/logger.ts';
import { spawnProcess } from '../../process/process.ts';
import { isWindows } from './platform-detector.ts';

const CONTAINER_RUNTIMES = ['docker', 'podman', 'nerdctl'] as const;
export type ContainerRuntime = (typeof CONTAINER_RUNTIMES)[number];

const WSL_EXECUTABLE = 'wsl.exe';

export interface ContainerRuntimeFailure {
  runtime: ContainerRuntime;
  exitCode: number | null;
  stderr: string;
}

type NativeRuntimeResult = 'available' | 'missing' | ContainerRuntimeFailure;

async function checkNativeRuntime(runtime: ContainerRuntime): Promise<NativeRuntimeResult> {
  try {
    const result = await spawnProcess(runtime, ['info']);
    return result.exitCode === 0
      ? 'available'
      : { runtime, exitCode: result.exitCode, stderr: result.stderr };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing';
    }
    return {
      runtime,
      exitCode: null,
      stderr: error instanceof Error ? error.message : String(error),
    };
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
  nativeFailure?: ContainerRuntimeFailure;
}

function getWslMode(windows: boolean): 'auto' | 'always' | 'never' {
  if (!windows) return 'never';
  const mode = process.env.SONAR_MCP_WSL ?? 'auto';
  if (mode !== 'auto' && mode !== 'always' && mode !== 'never') {
    throw new InvalidOptionError('SONAR_MCP_WSL must be auto, always, or never.');
  }
  return mode;
}

async function detectNativeRuntime(windows: boolean): Promise<ContainerRuntimeDetection> {
  let nativeFailure: ContainerRuntimeFailure | undefined;
  for (const runtime of CONTAINER_RUNTIMES) {
    const result = await checkNativeRuntime(runtime);
    if (result === 'available') {
      if (windows) logger.info(`Using native ${runtime} on Windows; WSL fallback is not needed.`);
      return { runtime, viaWsl: false };
    }
    if (result !== 'missing' && windows) nativeFailure ??= result;
  }
  return nativeFailure
    ? { runtime: null, viaWsl: false, nativeFailure }
    : { runtime: null, viaWsl: false };
}

async function detectWslRuntime(): Promise<ContainerRuntimeDetection> {
  for (const runtime of CONTAINER_RUNTIMES) {
    if (await isRuntimeAvailableViaWsl(runtime)) {
      return { runtime, viaWsl: true };
    }
  }
  return { runtime: null, viaWsl: false };
}

export async function detectContainerRuntime(): Promise<ContainerRuntimeDetection> {
  const windows = isWindows();
  const mode = getWslMode(windows);
  if (mode === 'always') {
    logger.info('SONAR_MCP_WSL=always; checking container runtimes through WSL only.');
    return detectWslRuntime();
  }
  if (windows && mode === 'never') {
    logger.info('SONAR_MCP_WSL=never; WSL will not be checked.');
  }

  const native = await detectNativeRuntime(windows);
  if (native.runtime || !windows) return native;
  if (native.nativeFailure) {
    const failure = native.nativeFailure;
    const exit = failure.exitCode === null ? '' : ` (exit ${failure.exitCode})`;
    logger.warn(
      `${failure.runtime} found on Windows but not reachable${exit}: ${failure.stderr}; not falling back to WSL.`,
    );
    return native;
  }
  if (mode === 'never') return native;

  logger.info('No native container runtime found on Windows; trying WSL.');
  return detectWslRuntime();
}
