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
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnProcess } from '../../../lib/process';
import type { SpawnResult } from '../../../lib/process';
import { buildLocalBinaryName, detectPlatform } from '../../../lib/platform-detector';
import { resolveAuth } from '../../../lib/auth-resolver';
import logger from '../../../lib/logger';
import { blank, error, info, print, success, text, warn } from '../../../ui';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';
import { BIN_DIR } from '../../../lib/config-constants';
import { SonarQubeClient } from '../../../sonarqube/client';
import type { A3sIssue } from '../../../sonarqube/client';
import { loadState, findExtensionsByProject } from '../../../lib/state-manager';
import type { HookExtension } from '../../../lib/state';

export interface AnalyzeSecretsOptions {
  file?: string;
  stdin?: boolean;
}

export interface AnalyzeFileOptions {
  file: string;
  branch?: string;
}

export interface AnalyzeA3sOptions {
  file: string;
  branch?: string;
  project?: string;
}

export async function analyzeSecrets(options: AnalyzeSecretsOptions): Promise<void> {
  return handleCheckCommand(options).catch(handleScanError);
}

// Env var names expected by the sonar-secrets binary
const BINARY_AUTH_URL_ENV = 'SONAR_SECRETS_AUTH_URL';
const BINARY_AUTH_TOKEN_ENV = 'SONAR_SECRETS_TOKEN';

const SCAN_TIMEOUT_MS = 30000;
const STDIN_READ_TIMEOUT_MS = 5000;

async function handleCheckCommand(options: AnalyzeSecretsOptions): Promise<void> {
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
  authUrl?: string;
  authToken?: string;
}

async function setupScanEnvironment(options: {
  file?: string;
  stdin?: boolean;
}): Promise<ScanEnvironment> {
  validateScanOptions(options);

  const binaryPath = setupBinaryPath();

  let authUrl: string | undefined;
  let authToken: string | undefined;
  try {
    const auth = await resolveAuth({});
    authUrl = auth.serverUrl;
    authToken = auth.token;
  } catch {
    // Auth resolution failure is non-fatal — binary works without auth
  }

  return { binaryPath, authUrl, authToken };
}

function validateScanOptions(options: { file?: string; stdin?: boolean }): void {
  if (!options.file && !options.stdin) {
    throw new InvalidOptionError('Either --file or --stdin is required');
  }

  if (options.file && options.stdin) {
    throw new InvalidOptionError('Cannot use both --file and --stdin');
  }
}

function setupBinaryPath(): string {
  const platform = detectPlatform();
  const binaryPath = join(BIN_DIR, buildLocalBinaryName(platform));

  validateCheckCommandEnvironment(binaryPath);

  return binaryPath;
}

async function performStdinScan(
  binaryPath: string,
  authUrl: string | undefined,
  authToken: string | undefined,
  scanStartTime: number,
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
  authUrl: string | undefined,
  authToken: string | undefined,
  scanStartTime: number,
): Promise<void> {
  if (!file) {
    throw new InvalidOptionError('File path is required');
  }

  if (!existsSync(file)) {
    throw new InvalidOptionError(`File not found: ${file}`);
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
    text('  Install with: sonar install secrets');
    throw new CommandFailedError('sonar-secrets is not installed');
  }
}

async function runScan(
  binaryPath: string,
  file: string,
  authUrl: string | undefined,
  authToken: string | undefined,
): Promise<SpawnResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      spawnProcess(binaryPath, ['--non-interactive', file], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...(authUrl && authToken
            ? { [BINARY_AUTH_URL_ENV]: authUrl, [BINARY_AUTH_TOKEN_ENV]: authToken }
            : {}),
        },
      }),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Scan timed out after ${SCAN_TIMEOUT_MS}ms`));
        }, SCAN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runScanFromStdin(
  binaryPath: string,
  authUrl: string | undefined,
  authToken: string | undefined,
): Promise<SpawnResult> {
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const pathModule = await import('node:path');
  const pathJoin = (...args: string[]) => pathModule.join(...args);

  const stdinData = await readStdin();

  const tempFile = pathJoin(tmpdir(), `sonar-secrets-scan-${Date.now()}.tmp`);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    writeFileSync(tempFile, stdinData);

    return await Promise.race([
      spawnProcess(binaryPath, [tempFile], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...(authUrl && authToken
            ? { [BINARY_AUTH_URL_ENV]: authUrl, [BINARY_AUTH_TOKEN_ENV]: authToken }
            : {}),
        },
      }),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Scan timed out after ${SCAN_TIMEOUT_MS}ms`));
        }, SCAN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
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
      setTimeout(() => {
        reject(new Error(`stdin read timeout after ${STDIN_READ_TIMEOUT_MS}ms`));
      }, STDIN_READ_TIMEOUT_MS),
    ),
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
  } catch (parseError) {
    logger.debug(`Failed to parse JSON output: ${(parseError as Error).message}`);
    blank();
    success('Scan completed successfully');
    blank();
    print(result.stdout);
    blank();
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
  exitCode: number,
): void {
  blank();
  error('Scan found secrets');
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
  throw new CommandFailedError(`Scan failed with exit code: ${exitCode}`, exitCode);
}

function handleScanError(err: unknown): void {
  if (err instanceof InvalidOptionError) {
    throw err;
  }

  if (err instanceof CommandFailedError) {
    throw err;
  }

  const errorMessage = (err as Error).message;

  blank();
  error(`Error: ${errorMessage}`);
  logger.error(`Scan error: ${errorMessage}`);

  if (errorMessage.includes('timed out')) {
    text(
      '\nThe scan took longer than 30 seconds.\nTry scanning a smaller file or check system resources.',
    );
  } else if (errorMessage.includes('ENOENT')) {
    text(
      '\nThe binary file was not found or is not executable.\nReinstall with: sonar install secrets --force',
    );
  } else {
    text('\nCheck installation with: sonar install secrets --status');
  }

  blank();
  throw new CommandFailedError(errorMessage);
}

// ---------------------------------------------------------------------------
// Full file analysis pipeline: secrets → A3S
// ---------------------------------------------------------------------------

const SECRETS_FOUND_EXIT_CODE = 51;

export async function analyzeFile(options: AnalyzeFileOptions): Promise<void> {
  const { file, branch } = options;

  if (!file) {
    throw new InvalidOptionError('--file is required');
  }

  if (!existsSync(file)) {
    throw new InvalidOptionError(`File not found: ${file}`);
  }

  // Step 1: secrets scan
  const secretsResult = await runSecretsOnFile(file);
  if (secretsResult === 'secrets-found') {
    blank();
    warn('Secrets detected in this file.');
    text('  Remove the secrets before running full analysis to get additional issues.');
    blank();
    return;
  }

  // Step 2: A3S analysis
  await runA3sAnalysis(file, branch);
}

// ---------------------------------------------------------------------------
// Standalone A3S analysis
// ---------------------------------------------------------------------------

export async function analyzeA3s(options: AnalyzeA3sOptions): Promise<void> {
  const { file, branch, project } = options;

  if (!existsSync(file)) {
    throw new InvalidOptionError(`File not found: ${file}`);
  }

  await runA3sAnalysis(file, branch, project);
}

// ---------------------------------------------------------------------------
// Shared A3S logic
// ---------------------------------------------------------------------------

async function runSecretsOnFile(file: string): Promise<'secrets-found' | 'ok'> {
  try {
    const platform = detectPlatform();
    const binaryPath = join(BIN_DIR, buildLocalBinaryName(platform));
    if (!existsSync(binaryPath)) {
      logger.debug('sonar-secrets binary not found, skipping secrets scan');
      return 'ok';
    }

    const auth = await resolveAuth({});
    const result = await runScan(binaryPath, file, auth.serverUrl, auth.token);
    if ((result.exitCode ?? 0) === SECRETS_FOUND_EXIT_CODE) {
      return 'secrets-found';
    }
    return 'ok';
  } catch (err) {
    logger.debug(`Secrets scan error (non-blocking): ${(err as Error).message}`);
    return 'ok';
  }
}

async function runA3sAnalysis(
  file: string,
  branch?: string,
  explicitProject?: string,
): Promise<void> {
  const auth = await resolveCloudAuth(explicitProject);
  if (!auth) return;

  const projectKey = explicitProject ?? resolveA3sProjectKey();
  if (!projectKey) return;

  const fileContent = readA3sFileContent(file);
  await callA3sApiAndDisplay(auth, projectKey, file, fileContent, branch);
}

/**
 * Resolve auth and validate that the connection is SonarQube Cloud.
 * Returns null when A3S should be silently skipped (no auth / on-premise without --project).
 * Throws CommandFailedError when --project is set but the connection is not Cloud.
 */
async function resolveCloudAuth(
  explicitProject: string | undefined,
): Promise<{ serverUrl: string; token: string; orgKey: string } | null> {
  let auth;
  try {
    auth = await resolveAuth({});
  } catch {
    logger.debug('A3S analysis skipped: failed to resolve auth');
    return null;
  }

  if (!auth.token || !auth.orgKey || auth.connectionType === 'on-premise') {
    if (explicitProject) {
      throw new CommandFailedError(
        'A3S analysis requires a SonarQube Cloud connection. Run: sonar auth login',
      );
    }
    logger.debug('A3S analysis skipped: no auth, missing orgKey, or on-premise server');
    return null;
  }

  return { serverUrl: auth.serverUrl, token: auth.token, orgKey: auth.orgKey };
}

/**
 * Look up the project key for the current directory from the agentExtensions registry.
 * Returns null when A3S should be silently skipped.
 */
function resolveA3sProjectKey(): string | null {
  try {
    const state = loadState();
    const extensions = findExtensionsByProject(state, 'claude-code', process.cwd());
    const a3sExt = extensions.find(
      (e): e is HookExtension => e.kind === 'hook' && e.name === 'sonar-a3s',
    );

    if (!a3sExt?.projectKey) {
      logger.debug('A3S analysis skipped: no project key found in extensions registry');
      if (process.stdin.isTTY) {
        info(
          'A3S analysis is not configured for this project. ' +
            'Run `sonar integrate claude` to set it up, or use --project to specify the project key explicitly.',
        );
      }
      return null;
    }

    return a3sExt.projectKey;
  } catch {
    logger.debug('A3S analysis skipped: failed to resolve extensions');
    return null;
  }
}

/**
 * Read file content for A3S analysis.
 * Throws CommandFailedError when the file cannot be read.
 */
function readA3sFileContent(file: string): string {
  try {
    return readFileSync(file, 'utf-8');
  } catch (err) {
    throw new CommandFailedError(`Failed to read file: ${(err as Error).message}`);
  }
}

/**
 * Call the A3S API and display the results.
 * Throws CommandFailedError on API failure.
 */
async function callA3sApiAndDisplay(
  auth: { serverUrl: string; token: string; orgKey: string },
  projectKey: string,
  file: string,
  fileContent: string,
  branch: string | undefined,
): Promise<void> {
  const filePath = relative(process.cwd(), file);
  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  blank();
  text('Running A3S analysis...');

  try {
    const response = await client.analyzeFile({
      organizationKey: auth.orgKey,
      projectKey,
      ...(branch ? { branchName: branch } : {}),
      filePath,
      fileContent,
    });

    displayA3sResults(response.issues, response.errors);
  } catch (err) {
    logger.error(`A3S analysis failed: ${(err as Error).message}`);
    blank();
    error('A3S analysis failed.');
    text(`  ${(err as Error).message}`);
    blank();
    throw new CommandFailedError('A3S analysis failed');
  }
}

function displayA3sResults(
  issues: A3sIssue[],
  errors?: Array<{ code: string; message: string }> | null,
): void {
  if (errors && errors.length > 0) {
    blank();
    error('A3S analysis returned errors:');
    errors.forEach((e) => {
      text(`  [${e.code}] ${e.message}`);
    });
    blank();
    return;
  }

  blank();
  if (issues.length === 0) {
    success('A3S analysis completed — no issues found.');
  } else {
    error(`A3S analysis found ${issues.length} issue${issues.length === 1 ? '' : 's'}:`);
    blank();
    issues.forEach((issue, idx) => {
      const location = issue.textRange ? ` (line ${issue.textRange.startLine})` : '';
      text(`  [${idx + 1}] ${issue.message}${location}`);
      text(`      Rule: ${issue.rule}`);
    });
  }
  blank();
}
