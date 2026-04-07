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
import { existsSync } from 'node:fs';
import { spawnProcess } from '../../../lib/process';
import type { SpawnOptions, SpawnResult, StdioMode } from '../../../lib/process';
import type { ResolvedAuth } from '../../../lib/auth-resolver';
import logger from '../../../lib/logger';
import { blank, error, print, success, text } from '../../../ui';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';
import { installSecretsBinary } from '../_common/install/secrets';

export interface AnalyzeSecretsOptions {
  paths?: string[];
  stdin?: boolean;
}

export async function analyzeSecrets(
  options: AnalyzeSecretsOptions,
  auth: ResolvedAuth,
): Promise<void> {
  return handleCheckCommand(options, auth).catch(handleScanError);
}

// Env var names expected by the sonar-secrets binary
const BINARY_AUTH_URL_ENV = 'SONAR_SECRETS_AUTH_URL';
const BINARY_AUTH_TOKEN_ENV = 'SONAR_SECRETS_TOKEN';

const SCAN_TIMEOUT_MS = 30000;

export const EXIT_CODE_SECRETS_FOUND = 51;

/**
 * Run sonar-secrets binary on the given files. Returns the full spawn result.
 * Kills the child process on timeout.
 */
export async function runSecretsBinary(
  binaryPath: string,
  files: string[],
  auth: ResolvedAuth,
  stdin: StdioMode = 'pipe',
): Promise<SpawnResult> {
  return spawnWithTimeout(binaryPath, ['--non-interactive', ...files], {
    stdin,
    stdout: 'pipe',
    stderr: 'pipe',
    env: buildAuthEnv(auth),
  });
}

/**
 * Run sonar-secrets binary on arbitrary text via stdin (--input mode). Returns the full spawn result.
 */
export async function runSecretsBinaryOnText(
  binaryPath: string,
  text: string,
  auth: ResolvedAuth,
): Promise<SpawnResult> {
  return spawnWithTimeout(binaryPath, ['--input'], {
    stdin: 'pipe',
    stdinData: text,
    stdout: 'pipe',
    stderr: 'pipe',
    env: buildAuthEnv(auth),
  });
}

function buildAuthEnv(auth: ResolvedAuth): Record<string, string> {
  return { [BINARY_AUTH_URL_ENV]: auth.serverUrl, [BINARY_AUTH_TOKEN_ENV]: auth.token };
}

async function spawnWithTimeout(
  binaryPath: string,
  args: string[],
  options: SpawnOptions,
): Promise<SpawnResult> {
  let killChild: (() => void) | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      spawnProcess(binaryPath, args, {
        ...options,
        onSpawn: (kill) => {
          killChild = kill;
        },
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          killChild?.();
          reject(new Error(`Scan timed out after ${SCAN_TIMEOUT_MS}ms`));
        }, SCAN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleCheckCommand(
  options: AnalyzeSecretsOptions,
  auth: ResolvedAuth,
): Promise<void> {
  validateScanOptions(options);
  const binaryPath = await installSecretsBinary();
  const scanStartTime = Date.now();

  if (options.stdin) {
    reportScanResult(
      await runSecretsBinary(binaryPath, ['--input'], auth, 'inherit'),
      scanStartTime,
    );
  } else {
    await performPathsScan(binaryPath, options.paths ?? [], auth, scanStartTime);
  }
}

function validateScanOptions(options: { paths?: string[]; stdin?: boolean }): void {
  const hasPaths = (options.paths?.length ?? 0) > 0;
  if (!hasPaths && !options.stdin) {
    throw new InvalidOptionError('Either provide file/directory paths or --stdin');
  }

  if (hasPaths && options.stdin) {
    throw new InvalidOptionError('Cannot use both paths and --stdin');
  }
}

async function performPathsScan(
  binaryPath: string,
  paths: string[],
  auth: ResolvedAuth,
  scanStartTime: number,
): Promise<void> {
  if (paths.length === 0) {
    throw new InvalidOptionError('At least one path is required');
  }

  for (const p of paths) {
    if (!existsSync(p)) {
      throw new InvalidOptionError(`Path not found: ${p}`);
    }
  }

  const result = await runSecretsBinary(binaryPath, paths, auth);
  reportScanResult(result, scanStartTime);
}

function reportScanResult(result: SpawnResult, scanStartTime: number): void {
  const scanDurationMs = Date.now() - scanStartTime;
  const exitCode = result.exitCode ?? 1;
  if (exitCode === 0) {
    handleScanSuccess(result, scanDurationMs);
  } else {
    handleScanFailure(result, scanDurationMs, exitCode);
  }
}

function handleScanSuccess(result: { stdout: string }, scanDurationMs: number): void {
  blank();
  success('Scan completed successfully');
  try {
    const scanResult = JSON.parse(result.stdout);
    text(`  Duration: ${scanDurationMs}ms`);
    displayScanResults(scanResult);
  } catch (parseError) {
    logger.debug(`Failed to parse JSON output: ${(parseError as Error).message}`);
    blank();
    print(result.stdout);
  }
  blank();
}

function displayScanResults(scanResult: {
  issues?: Array<{ message?: string; line?: number; severity?: string }>;
}): void {
  if (!scanResult.issues || !Array.isArray(scanResult.issues)) {
    text('  No issues detected');
    return;
  }

  text(`  Issues found: ${scanResult.issues.length}`);
  if (scanResult.issues.length === 0) {
    return;
  }

  blank();
  scanResult.issues.forEach((issue, idx) => {
    error(`  [${idx + 1}] ${issue.message ?? 'Unknown issue'}`);
    if (issue.line) {
      text(`      Line: ${issue.line}`);
    }
    if (issue.severity) {
      text(`      Severity: ${issue.severity}`);
    }
  });
}

function handleScanFailure(
  result: { exitCode: number | null; stderr: string; stdout: string },
  scanDurationMs: number,
  exitCode: number,
): void {
  blank();

  const output = [result.stderr, result.stdout].filter(Boolean).join('\n');
  if (output) {
    print(output);
    blank();
  }

  if (exitCode === EXIT_CODE_SECRETS_FOUND) {
    throw new CommandFailedError(`Secrets found (${scanDurationMs}ms)`, exitCode);
  }

  throw new CommandFailedError(`Scan error (exit code ${exitCode})`, exitCode);
}

function handleScanError(err: unknown): void {
  if (err instanceof InvalidOptionError || err instanceof CommandFailedError) {
    throw err;
  }

  const errorMessage = (err as Error).message;

  let details: string;
  if (errorMessage.includes('timed out')) {
    details =
      '\nThe scan took longer than 30 seconds.\nTry scanning a smaller file or check system resources.';
  } else if (errorMessage.includes('ENOENT')) {
    details =
      '\nThe secrets analyzer binary was not found or is not executable.\nRun: sonar integrate';
  } else {
    details = '\nRun: sonar integrate';
  }

  throw new CommandFailedError(`Error: ${errorMessage}\n${details}\n`);
}
