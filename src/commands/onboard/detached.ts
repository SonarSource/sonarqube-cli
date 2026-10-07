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

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  assertValidServerUrl,
  ResolvedAuth,
  type ResolvedAuthInit,
} from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { CLI_TMP_DIR, LOG_DIR } from '@/core/config-constants.ts';
import {
  buildSubprocessNetworkEnv,
  getNetworkConfigOrThrow,
} from '@/core/host/connectivity/network-config.ts';
import type { ScannerInstallation } from '@/core/host/install/scanner-discovery.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { resolveSafePath } from '../system/safe-path.ts';
import { OnboardApiClient } from './onboard-api.ts';
import { runFirstAnalysis } from './scanner.ts';

export const ONBOARD_WORKER_ARGUMENT = '--internal-onboard-analysis-worker';
const STARTUP_TIMEOUT_MS = 10000;

interface DetachedJob {
  id: string;
  directory: string;
  scanner: ScannerInstallation;
  projectRoot: string;
  projectKey: string;
  projectName?: string;
  scannerProperties?: string[];
  auth: ResolvedAuthInit;
  networkEnv: NodeJS.ProcessEnv;
  dashboardUrl: string;
}

export interface DetachedAnalysis {
  pid: number;
  logPath: string;
  statusPath: string;
}

export interface DetachedAnalysisStatus {
  status: 'running' | 'uploaded' | 'completed' | 'failed';
  pid: number;
  projectKey: string;
  dashboardUrl: string;
  scannerLogPath: string;
  taskId?: string;
  analysisId?: string;
  qualityGate?: string | null;
  error?: string;
  warnings?: string[];
}

function jobPaths(id: string): { logPath: string; statusPath: string } {
  return {
    logPath: join(LOG_DIR, `sonar-scanner-${id}.log`),
    statusPath: join(LOG_DIR, `sonar-onboard-${id}.json`),
  };
}

export function createDetachedWorkDirectory(): string {
  mkdirSync(CLI_TMP_DIR, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(CLI_TMP_DIR, 'onboard-'));
}

function writeStatus(path: string, status: DetachedAnalysisStatus): void {
  const staging = `${path}.tmp`;
  writeFileSync(staging, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 });
  renameSync(staging, path);
}

function messageType(message: unknown): string | undefined {
  return typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    typeof message.type === 'string'
    ? message.type
    : undefined;
}

export async function startDetachedAnalysis(
  input: Omit<DetachedJob, 'id'>,
): Promise<DetachedAnalysis> {
  const job: DetachedJob = { ...input, id: randomUUID() };
  const paths = jobPaths(job.id);
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(
    paths.logPath,
    `SonarScanner ${job.scanner.version}\nProject: ${job.projectKey}\n\n`,
    { mode: 0o600 },
  );
  const command = Bun.isStandaloneExecutable
    ? [process.execPath, ONBOARD_WORKER_ARGUMENT]
    : [process.execPath, Bun.main, ONBOARD_WORKER_ARGUMENT];
  const networkEnv = await buildSubprocessNetworkEnv(await getNetworkConfigOrThrow());
  const worker = await new Promise<ReturnType<typeof Bun.spawn>>((resolve, reject) => {
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (message: string) => {
      if (ready) return;
      ready = true;
      clearTimeout(timer);
      timer = undefined;
      reject(
        new CommandFailedError(message, {
          remediationHint: `Inspect ${paths.logPath} for background analysis diagnostics.`,
        }),
      );
    };
    const child = Bun.spawn(command, {
      cwd: input.projectRoot,
      env: { ...process.env, ...networkEnv },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      serialization: 'json',
      ipc(message: unknown) {
        if (messageType(message) === 'accepting') child.send(job);
        else if (messageType(message) === 'ready' && !ready) {
          ready = true;
          clearTimeout(timer);
          timer = undefined;
          resolve(child);
        } else if (messageType(message) === 'failed') {
          fail('The background analysis worker could not start. Inspect the scanner log.');
        }
      },
      onExit(_child, exitCode) {
        fail(`The background analysis worker exited before starting (code ${exitCode}).`);
      },
    });
    timer = setTimeout(() => {
      child.kill();
      fail('Starting the background analysis worker timed out.');
    }, STARTUP_TIMEOUT_MS);
  });
  worker.disconnect();
  worker.unref();
  return { pid: worker.pid, ...paths };
}

function validateJob(input: unknown): DetachedJob {
  if (typeof input !== 'object' || input === null)
    throw new CommandFailedError('Invalid background analysis input.');
  const job = input as Partial<DetachedJob>;
  if (
    typeof job.id !== 'string' ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(job.id) ||
    typeof job.directory !== 'string' ||
    typeof job.projectRoot !== 'string' ||
    typeof job.projectKey !== 'string' ||
    !job.projectKey ||
    typeof job.dashboardUrl !== 'string' ||
    !job.auth ||
    typeof job.auth.token !== 'string' ||
    !job.auth.token ||
    typeof job.auth.serverUrl !== 'string' ||
    !job.scanner ||
    typeof job.scanner.javaPath !== 'string' ||
    typeof job.scanner.home !== 'string' ||
    typeof job.scanner.classPath !== 'string' ||
    typeof job.scanner.version !== 'string' ||
    (job.scannerProperties !== undefined &&
      (!Array.isArray(job.scannerProperties) ||
        !job.scannerProperties.every((property) => typeof property === 'string'))) ||
    !job.networkEnv ||
    typeof job.networkEnv !== 'object'
  ) {
    throw new CommandFailedError('Invalid background analysis input.');
  }
  assertValidServerUrl(job.auth.serverUrl, 'Check the background analysis server URL.');
  const safeDirectory = resolveSafePath(job.directory, [CLI_TMP_DIR]);
  if (
    !safeDirectory ||
    dirname(safeDirectory) !== canonicalizePath(CLI_TMP_DIR) ||
    !basename(safeDirectory).startsWith('onboard-')
  ) {
    throw new CommandFailedError('Invalid background analysis working directory.');
  }
  return { ...(job as DetachedJob), directory: safeDirectory };
}

async function receiveJob(): Promise<DetachedJob> {
  if (!process.connected || !process.send)
    throw new CommandFailedError('The internal analysis worker requires an IPC connection.');
  return new Promise<DetachedJob>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CommandFailedError('No background analysis input received.'));
    }, STARTUP_TIMEOUT_MS);
    process.once('message', (message: unknown) => {
      clearTimeout(timer);
      try {
        resolve(validateJob(message));
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new CommandFailedError('Invalid background analysis input.'),
        );
      }
    });
    process.send?.({ type: 'accepting' });
  });
}

export async function runDetachedAnalysisWorker(): Promise<void> {
  let job: DetachedJob | undefined;
  let ready = false;
  let status: DetachedAnalysisStatus | undefined;
  try {
    job = await receiveJob();
    const { logPath, statusPath } = jobPaths(job.id);
    status = {
      status: 'running',
      pid: process.pid,
      projectKey: job.projectKey,
      dashboardUrl: job.dashboardUrl,
      scannerLogPath: logPath,
    };
    writeStatus(statusPath, status);
    process.send?.({ type: 'ready' });
    ready = true;
    const auth = new ResolvedAuth(job.auth);
    const networkEnv: NodeJS.ProcessEnv = {
      SONAR_SCANNER_PROXY_HOST: undefined,
      SONAR_SCANNER_PROXY_PORT: undefined,
      SONAR_SCANNER_PROXY_USER: undefined,
      SONAR_SCANNER_PROXY_PASSWORD: undefined,
      ...job.networkEnv,
    };
    const { taskId } = await runFirstAnalysis(
      job.scanner,
      job.projectRoot,
      job.projectKey,
      auth,
      job.directory,
      networkEnv,
      undefined,
      job.projectName,
      logPath,
      job.scannerProperties,
    );
    const api = new OnboardApiClient(new SonarHttpClient(auth.serverUrl, auth.token));
    status.status = 'uploaded';
    status.taskId = taskId;
    writeStatus(statusPath, status);
    status.analysisId = await api.waitForAnalysis(taskId, job.projectKey);
    status.status = 'completed';
    try {
      status.qualityGate = await api.qualityGate(status.analysisId);
    } catch {
      status.qualityGate = null;
      status.warnings = ['Could not retrieve the quality gate.'];
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (job) {
      const { logPath } = jobPaths(job.id);
      const safeMessage = message.replaceAll(job.auth.token, '[REDACTED]');
      appendFileSync(logPath, safeMessage + '\n');
      status = {
        status: 'failed',
        pid: process.pid,
        projectKey: job.projectKey,
        dashboardUrl: job.dashboardUrl,
        scannerLogPath: logPath,
        error: safeMessage,
      };
    }
    if (!ready && process.connected) process.send?.({ type: 'failed' });
    process.exitCode = 1;
  } finally {
    if (job) {
      rmSync(job.directory, { recursive: true, force: true });
      if (status) writeStatus(jobPaths(job.id).statusPath, status);
    }
    if (process.connected) process.disconnect();
  }
}
