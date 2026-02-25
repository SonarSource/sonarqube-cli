/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Scan logic for sonar secret check command

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnProcess } from '../lib/process.js';
import { BIN_DIR } from '../lib/config-constants.js';
import { buildLocalBinaryName, detectPlatform } from '../lib/platform-detector.js';
import { getActiveConnection, loadState } from '../lib/state-manager.js';
import { getToken } from '../lib/keychain.js';
import { version as VERSION } from '../../package.json';
import logger from '../lib/logger.js';
import { text, blank, success, error, print } from '../ui/index.js';

const SCAN_TIMEOUT_MS = 30000;
const STDIN_READ_TIMEOUT_MS = 5000;
const SECRET_SCAN_POSITIVE_EXIT_CODE = 51;

/**
 * Check command: sonar secret check [--file <path>] [--stdin]
 */
export const secretCheckCommand = performCheckCommand;

async function performCheckCommand(options: {
  file?: string;
  stdin?: boolean;
}): Promise<void> {
  return handleCheckCommand(options).catch(handleScanError);
}

async function handleCheckCommand(options: {
  file?: string;
  stdin?: boolean;
}): Promise<void> {
  const scanEnv = await setupScanEnvironment(options);
  const scanStartTime = Date.now();
  const { binaryPath, authUrl, authToken } = scanEnv;

  if (options.stdin) {
    await performStdinScan(binaryPath, authUrl, authToken, scanStartTime);
  } else {
    await performFileScan(binaryPath, options.file, authUrl, authToken, scanStartTime);
  }
}

interface ScanEnvironment {
  binaryPath: string;
  authUrl: string;
  authToken: string;
}

async function setupScanEnvironment(options: { file?: string; stdin?: boolean }): Promise<ScanEnvironment> {
  validateScanOptions(options);

  const binaryPath = setupBinaryPath();
  const { authUrl, authToken } = await setupAuth();

  return { binaryPath, authUrl, authToken };
}

function validateScanOptions(options: { file?: string; stdin?: boolean }): void {
  if (!options.file && !options.stdin) {
    error('Either --file or --stdin is required');
    process.exit(1);
  }

  if (options.file && options.stdin) {
    error('Cannot use both --file and --stdin');
    process.exit(1);
  }
}

function setupBinaryPath(): string {
  const platform = detectPlatform();
  const binaryPath = join(BIN_DIR, buildLocalBinaryName(platform));

  validateCheckCommandEnvironment(binaryPath);

  return binaryPath;
}

async function setupAuth(): Promise<{ authUrl: string; authToken: string }> {
  const state = loadState(VERSION);
  const activeConnection = getActiveConnection(state);

  if (!activeConnection) {
    logAuthConfigError();
    process.exit(1);
  }

  const authUrl = activeConnection.serverUrl;
  const authToken = await getToken(authUrl, activeConnection.orgKey);

  if (!authUrl || !authToken) {
    logAuthConfigError();
    process.exit(1);
  }

  return { authUrl, authToken };
}

async function performStdinScan(
  binaryPath: string,
  authUrl: string,
  authToken: string,
  scanStartTime: number
): Promise<void> {
  const result = await runScanFromStdin(binaryPath, authUrl, authToken);
  const scanDurationMs = Date.now() - scanStartTime;

  const exitCode = result.exitCode ?? 1;
  if (exitCode === 0) {
    handleScanSuccess(result, scanDurationMs);
  } else {
    handleScanFailure(result, scanDurationMs, exitCode);
  }
}

async function performFileScan(
  binaryPath: string,
  file: string | undefined,
  authUrl: string,
  authToken: string,
  scanStartTime: number
): Promise<void> {
  if (!file) {
    error('File path is required');
    process.exit(1);
  }

  if (!existsSync(file)) {
    error(`File not found: ${file}`);
    process.exit(1);
  }

  const result = await runScan(binaryPath, file, authUrl, authToken);
  const scanDurationMs = Date.now() - scanStartTime;

  const exitCode = result.exitCode ?? 1;
  if (exitCode === 0) {
    handleScanSuccess(result, scanDurationMs);
  } else {
    handleScanFailure(result, scanDurationMs, exitCode);
  }
}

function validateCheckCommandEnvironment(binaryPath: string): void {
  if (!existsSync(binaryPath)) {
    error('sonar-secrets is not installed');
    text('  Install with: sonar secret install');
    process.exit(1);
  }
}

function logAuthConfigError(): void {
  error('sonar-secrets authentication is not configured');
  text([
    '',
    'Configure authentication by setting environment variables:',
    '  export SONAR_SECRETS_AUTH_URL=<url>',
    '  export SONAR_SECRETS_TOKEN=<token>',
    '',
    'For SonarQube Cloud: SONAR_SECRETS_AUTH_URL=https://sonarcloud.io',
    'For on-premise: SONAR_SECRETS_AUTH_URL=https://your-sonarqube-server',
  ].join('\n'));
}

async function runScan(
  binaryPath: string,
  file: string,
  authUrl: string,
  authToken: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return Promise.race([
    spawnProcess(binaryPath, [file], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SONAR_SECRETS_AUTH_URL: authUrl,
        SONAR_SECRETS_TOKEN: authToken
      }
    }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`Scan timed out after ${SCAN_TIMEOUT_MS}ms`)),
        SCAN_TIMEOUT_MS
      )
    )
  ]);
}

async function runScanFromStdin(
  binaryPath: string,
  authUrl: string,
  authToken: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pathJoin } = await import('node:path');

  const stdinData = await readStdin();

  const tempFile = pathJoin(tmpdir(), `sonar-secrets-scan-${Date.now()}.tmp`);

  try {
    writeFileSync(tempFile, stdinData);

    return await Promise.race([
      spawnProcess(binaryPath, [tempFile], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          SONAR_SECRETS_AUTH_URL: authUrl,
          SONAR_SECRETS_TOKEN: authToken
        }
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`Scan timed out after ${SCAN_TIMEOUT_MS}ms`)),
          SCAN_TIMEOUT_MS
        )
      )
    ]);
  } finally {
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function readStdin(): Promise<string> {
  return Promise.race([
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];

      process.stdin.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      process.stdin.on('end', () => {
        const content = Buffer.concat(chunks).toString('utf-8');
        resolve(content);
      });

      process.stdin.on('error', (err) => {
        reject(err);
      });
    }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`stdin read timeout after ${STDIN_READ_TIMEOUT_MS}ms`)),
        STDIN_READ_TIMEOUT_MS
      )
    )
  ]);
}

function handleScanSuccess(result: { stdout: string }, scanDurationMs: number): void {
  try {
    const scanResult = JSON.parse(result.stdout);
    blank();
    success('Scan completed successfully');
    text(`  Duration: ${scanDurationMs}ms`);
    displayScanResults(scanResult);
    blank();
    process.exit(0);
  } catch (parseError) {
    logger.debug(`Failed to parse JSON output: ${(parseError as Error).message}`);
    blank();
    success('Scan completed successfully');
    blank();
    print(result.stdout);
    blank();
    process.exit(0);
  }
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
  exitCode: number
): void {
  blank();
  error('Scan failed');
  logger.error(`Scan failed with exit code: ${exitCode}`);
  text(`  Exit code: ${exitCode}`);
  text(`  Duration: ${scanDurationMs}ms`);

  if (result.stderr) {
    blank();
    text('Error output:');
    print(result.stderr);
  }

  if (result.stdout) {
    blank();
    text('Output:');
    print(result.stdout);
  }
  blank();
  // Binary exit 1 = secrets found — remap to 51 so hooks can distinguish from generic errors
  process.exit(exitCode === 1 ? SECRET_SCAN_POSITIVE_EXIT_CODE : exitCode);
}

function handleScanError(err: unknown): void {
  const errorMessage = (err as Error).message;

  blank();
  error(`Error: ${errorMessage}`);
  logger.error(`Scan error: ${errorMessage}`);

  if (errorMessage.includes('timed out')) {
    text('\nThe scan took longer than 30 seconds.\nTry scanning a smaller file or check system resources.');
  } else if (errorMessage.includes('ENOENT')) {
    text('\nThe binary file was not found or is not executable.\nReinstall with: sonar secret install --force');
  } else {
    text('\nCheck installation with: sonar secret status');
  }

  blank();
  process.exit(1);
}
