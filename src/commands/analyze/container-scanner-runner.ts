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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ENV_ORG,
  ENV_SERVER,
  ENV_TOKEN,
  isSonarQubeCloud,
  requireCloudOrganization,
  type ResolvedAuth,
} from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import {
  buildSubprocessNetworkEnv,
  GENERIC_PROXY_ENV_NAMES,
  SUBPROCESS_NETWORK_ENV_NAMES,
} from '@/core/host/connectivity/network-config.ts';
import logger from '@/core/observability/logger.ts';
import { spawnProcessWithTimeout, type SpawnResult } from '@/core/process/process.ts';

export const CONTAINER_SCAN_ENGINES = ['docker', 'podman'] as const;
export type ContainerScanEngine = (typeof CONTAINER_SCAN_ENGINES)[number];

export const CONTAINER_SCAN_SEVERITIES = [
  'none',
  'info',
  'low',
  'medium',
  'high',
  'blocker',
] as const;
export type ContainerScanSeverity = (typeof CONTAINER_SCAN_SEVERITIES)[number];

export const DEFAULT_CONTAINER_FAIL_ON = 'high';
export const DEFAULT_CONTAINER_TIMEOUT_SECS = 300;

export interface ContainerScanOptions {
  containerEngine?: ContainerScanEngine;
  registry?: string;
  repository?: string;
  tag?: string;
  timeoutSecs: number;
  failOn: ContainerScanSeverity;
}

const MANAGED_ENV_NAMES = new Set([
  ENV_ORG,
  ENV_SERVER,
  ENV_TOKEN,
  'SONAR_CONTAINER_SCANNER_ORG',
  'SONAR_CONTAINER_SCANNER_TOKEN',
  'SONAR_CONTAINER_SCANNER_SKIP_UPDATE_CHECK',
  'SONAR_HOST_URL',
  'SONAR_SCANNER_API_BASE_URL',
  ...SUBPROCESS_NETWORK_ENV_NAMES,
  ...GENERIC_PROXY_ENV_NAMES,
]);
const SCRATCH_DIR_PREFIX = 'sonar-container-scan-';
const SCRATCH_RM_MAX_RETRIES = 3;
const SCRATCH_RM_RETRY_DELAY_MS = 100;
const MAX_TIMER_MS = 2_147_483_647;
const TIMED_SCANNER_PHASES = 3;
const WATCHDOG_GRACE_SECS = 30;
const CANCELLATION_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

type CancellationSignal = keyof typeof CANCELLATION_EXIT_CODES;
export type ContainerScanCancellationExitCode =
  (typeof CANCELLATION_EXIT_CODES)[CancellationSignal];

export class ContainerScanCancelledError extends CommandFailedError {
  declare readonly exitCode: ContainerScanCancellationExitCode;

  constructor(signal: CancellationSignal) {
    super('Container scan cancelled.', { exitCode: CANCELLATION_EXIT_CODES[signal] });
    this.name = 'ContainerScanCancelledError';
  }
}

export async function prepareContainerScannerEnv(
  auth: ResolvedAuth,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  // Let a Cloud URL resolved as `on-premise` (missing SONARQUBE_CLI_ORG) fall through to requireCloudOrganization.
  if (auth.connectionType !== 'cloud' && !isSonarQubeCloud(auth.serverUrl)) {
    throw new CommandFailedError('Container scanning is available only on SonarQube Cloud.', {
      remediationHint: "Run 'sonar auth login' to connect to SonarQube Cloud.",
    });
  }
  const organization = requireCloudOrganization(auth);
  const network = await buildSubprocessNetworkEnv(undefined, { includeClientCert: false });
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([name]) => !MANAGED_ENV_NAMES.has(name.toUpperCase())),
  );
  return {
    ...env,
    ...network,
    SONAR_CONTAINER_SCANNER_ORG: organization,
    SONAR_CONTAINER_SCANNER_TOKEN: auth.token,
    SONAR_HOST_URL: auth.serverUrl,
  };
}

function scanArguments(image: string, options: ContainerScanOptions): string[] {
  const argumentsByFlag = [
    ['container-engine', options.containerEngine],
    ['registry', options.registry],
    ['repository', options.repository],
    ['tag', options.tag],
    ['timeout-secs', options.timeoutSecs],
    ['fail-on', options.failOn],
  ] as const;
  const args = ['--format', 'json', '--skip-update-check'];
  for (const [flag, value] of argumentsByFlag) {
    if (value !== undefined) args.push(`--${flag}=${value}`);
  }
  return [...args, '--', image];
}

function scratchTempEnvNames(): readonly string[] {
  return process.platform === 'win32' ? ['TMPDIR', 'TMP', 'TEMP'] : ['TMPDIR'];
}

function resolveTempRoot(env: NodeJS.ProcessEnv): string {
  const candidates = process.platform === 'win32' ? ['TEMP', 'TMP', 'TMPDIR'] : ['TMPDIR'];
  for (const target of candidates) {
    const match = Object.entries(env).find(([key]) =>
      process.platform === 'win32' ? key.toUpperCase() === target : key === target,
    );
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return tmpdir();
}

function withScratchTempEnv(env: NodeJS.ProcessEnv, scratchDir: string): NodeJS.ProcessEnv {
  const tempNames = scratchTempEnvNames();
  const strippedNames = new Set(tempNames);
  const filtered = Object.fromEntries(
    Object.entries(env).filter(([key]) => !strippedNames.has(key.toUpperCase())),
  );
  for (const name of tempNames) {
    filtered[name] = scratchDir;
  }
  return filtered;
}

function removeScratchDir(scratchDir: string): void {
  try {
    rmSync(scratchDir, {
      recursive: true,
      force: true,
      maxRetries: SCRATCH_RM_MAX_RETRIES,
      retryDelay: SCRATCH_RM_RETRY_DELAY_MS,
    });
  } catch (error) {
    logger.debug(
      `Failed to remove container scanner scratch directory '${scratchDir}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function runContainerScanner(
  binaryPath: string,
  image: string,
  options: ContainerScanOptions,
  env: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  // Budget for image export, SBOM generation, and submission, plus startup and the Docker metadata probe.
  const watchdogMs = Math.min(
    MAX_TIMER_MS,
    (TIMED_SCANNER_PHASES * options.timeoutSecs + WATCHDOG_GRACE_SECS) * 1000,
  );
  const scratchDir = mkdtempSync(join(resolveTempRoot(env), SCRATCH_DIR_PREFIX));
  const scannerEnv = withScratchTempEnv(env, scratchDir);
  const cancellation = new AbortController();
  let cancelledBy: CancellationSignal | undefined;
  function cancel(signal: CancellationSignal): void {
    cancelledBy ??= signal;
    cancellation.abort();
  }
  // Detached Unix process groups escape parent SIGHUP (and uncatchable SIGKILL); forward SIGHUP on POSIX.
  const signals: readonly CancellationSignal[] =
    process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const listeners = signals.map((signal) => {
    const listener = (): void => {
      cancel(signal);
    };
    process.on(signal, listener);
    return [signal, listener] as const;
  });
  try {
    let result: SpawnResult;
    try {
      result = await spawnProcessWithTimeout(
        binaryPath,
        scanArguments(image, options),
        {
          env: scannerEnv,
          isolateEnv: true,
          killProcessTree: true,
          signal: cancellation.signal,
        },
        watchdogMs,
        'The container scanner did not exit after its scan timeout.',
      );
    } catch (error) {
      if (cancelledBy) throw new ContainerScanCancelledError(cancelledBy);
      throw error;
    }
    if (cancelledBy) throw new ContainerScanCancelledError(cancelledBy);
    return result;
  } finally {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    removeScratchDir(scratchDir);
  }
}
