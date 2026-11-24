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
  getNetworkConfigOrThrow,
} from '@/core/host/connectivity/network-config.ts';
import { spawnProcessWithTimeout, type SpawnResult } from '@/core/process/process.ts';

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
  containerEngine?: string;
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
]);
const MAX_TIMER_MS = 2_147_483_647;
const TIMED_SCANNER_PHASES = 3;
const WATCHDOG_GRACE_SECS = 30;

export async function prepareContainerScannerEnv(auth: ResolvedAuth): Promise<NodeJS.ProcessEnv> {
  if (auth.connectionType !== 'cloud' && !isSonarQubeCloud(auth.serverUrl)) {
    throw new CommandFailedError('Container scanning is available only on SonarQube Cloud.', {
      remediationHint: "Run 'sonar auth login' to connect to SonarQube Cloud.",
    });
  }
  const organization = requireCloudOrganization(auth);
  const network = await buildSubprocessNetworkEnv(await getNetworkConfigOrThrow());
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      const key = name.toUpperCase();
      return !MANAGED_ENV_NAMES.has(key) && !Object.hasOwn(network, key);
    }),
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
  let killScanner: (() => void) | undefined;
  const cancellation = new AbortController();
  function cancel(): void {
    cancellation.abort();
    killScanner?.();
  }

  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const result = await spawnProcessWithTimeout(
      binaryPath,
      scanArguments(image, options),
      {
        env,
        isolateEnv: true,
        onSpawn: (kill) => {
          killScanner = kill;
          if (cancellation.signal.aborted) kill();
        },
      },
      watchdogMs,
      'The container scanner did not exit after its scan timeout.',
    );
    if (cancellation.signal.aborted) throw new CommandFailedError('Container scan cancelled.');
    return result;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
