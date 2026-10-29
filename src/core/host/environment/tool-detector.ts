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
import { spawnProcessWithTimeout } from '../../process/process.ts';
import { isWindows } from './platform-detector.ts';

const RUNTIME_INFO_TIMEOUT_MS = 3_000;
const CONTAINER_RUNTIMES = ['docker', 'podman', 'nerdctl'] as const;
export type ContainerRuntime = (typeof CONTAINER_RUNTIMES)[number];

const WSL_EXECUTABLE = 'wsl.exe';
const RUNTIME_PROBE_TIMEOUT_MESSAGE = 'Container runtime probe timed out';
const MAX_RUNTIME_ERROR_LINES = 3;
const MAX_RUNTIME_ERROR_LENGTH = 1000;

export interface ContainerRuntimeFailure {
  runtime: ContainerRuntime;
  exitCode: number | null;
  stderr: string;
}

type NativeRuntimeResult = 'available' | 'missing' | ContainerRuntimeFailure;

function summarizeRuntimeError(stderr: string): string {
  return (
    stderr
      .trim()
      .split(/\r?\n/)
      .slice(0, MAX_RUNTIME_ERROR_LINES)
      .join('\n')
      .slice(0, MAX_RUNTIME_ERROR_LENGTH) || 'No error output.'
  );
}

async function checkNativeRuntime(runtime: ContainerRuntime): Promise<NativeRuntimeResult> {
  try {
    const result = await spawnProcessWithTimeout(
      runtime,
      ['info'],
      {},
      RUNTIME_INFO_TIMEOUT_MS,
      `${runtime} info timed out`,
    );
    return result.exitCode === 0
      ? 'available'
      : { runtime, exitCode: result.exitCode, stderr: summarizeRuntimeError(result.stderr) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing';
    }
    return {
      runtime,
      exitCode: null,
      stderr: summarizeRuntimeError(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function isRuntimeAvailableViaWsl(runtime: ContainerRuntime): Promise<boolean> {
  try {
    const result = await spawnProcessWithTimeout(
      WSL_EXECUTABLE,
      [runtime, 'info'], // only support the default distro
      {},
      RUNTIME_INFO_TIMEOUT_MS,
      `${runtime} info timed out`,
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export type ContainerRuntimeHealth =
  | { status: 'ready'; runtime: ContainerRuntime; viaWsl: boolean }
  | { status: 'not_ready'; runtime: ContainerRuntime; viaWsl: boolean; reason?: 'timeout' }
  | { status: 'not_found' };

type RuntimeProbeResult = 'ready' | 'failed' | 'timed_out' | 'missing';

async function probeRuntime(
  runtime: ContainerRuntime,
  viaWsl: boolean,
  args: string[],
): Promise<RuntimeProbeResult> {
  try {
    const result = await spawnProcessWithTimeout(
      viaWsl ? WSL_EXECUTABLE : runtime,
      viaWsl ? [runtime, ...args] : args,
      {},
      RUNTIME_INFO_TIMEOUT_MS,
      RUNTIME_PROBE_TIMEOUT_MESSAGE,
    );
    return result.exitCode === 0 ? 'ready' : 'failed';
  } catch (error) {
    if (error instanceof Error && error.message === RUNTIME_PROBE_TIMEOUT_MESSAGE) {
      return 'timed_out';
    }
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed';
  }
}

async function probeRuntimeSet(viaWsl: boolean): Promise<ContainerRuntimeHealth> {
  let firstNativeFailure: ContainerRuntime | undefined;
  for (const runtime of CONTAINER_RUNTIMES) {
    const result = await probeRuntime(runtime, viaWsl, ['info']);
    if (result === 'ready') return { status: 'ready', runtime, viaWsl };
    if (result === 'timed_out') {
      return { status: 'not_ready', runtime, viaWsl, reason: 'timeout' };
    }
    if (!viaWsl && result === 'failed') firstNativeFailure ??= runtime;
  }
  const installed = await Promise.all(
    CONTAINER_RUNTIMES.map((runtime) => probeRuntime(runtime, viaWsl, ['--version'])),
  );
  const installedIndex = installed.indexOf('ready');
  if (installedIndex >= 0) {
    return { status: 'not_ready', runtime: CONTAINER_RUNTIMES[installedIndex], viaWsl };
  }
  return firstNativeFailure
    ? { status: 'not_ready', runtime: firstNativeFailure, viaWsl }
    : { status: 'not_found' };
}

export async function checkContainerRuntimeHealth(): Promise<ContainerRuntimeHealth> {
  const windows = isWindows();
  const mode = getWslMode(windows);
  if (mode === 'always') return probeRuntimeSet(true);
  const native = await probeRuntimeSet(false);
  if (native.status !== 'not_found' || mode === 'never') return native;
  return probeRuntimeSet(true);
}

export interface ContainerRuntimeDetection {
  runtime: ContainerRuntime | null;
  viaWsl: boolean;
  nativeFailure?: ContainerRuntimeFailure;
  wslOnly?: boolean;
}

function getWslMode(windows: boolean): 'auto' | 'always' | 'never' {
  if (!windows) return 'never';
  const mode = process.env.SONARQUBE_CLI_MCP_WSL?.trim().toLowerCase() || 'auto';
  if (mode !== 'auto' && mode !== 'always' && mode !== 'never') {
    throw new InvalidOptionError('SONARQUBE_CLI_MCP_WSL must be auto, always, or never.');
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
    logger.info('SONARQUBE_CLI_MCP_WSL=always; checking container runtimes through WSL only.');
    const detection = await detectWslRuntime();
    return detection.runtime ? detection : { ...detection, wslOnly: true };
  }
  if (windows && mode === 'never') {
    logger.info('SONARQUBE_CLI_MCP_WSL=never; WSL will not be checked.');
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
