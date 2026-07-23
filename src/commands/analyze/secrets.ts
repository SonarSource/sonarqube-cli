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
import { existsSync } from 'node:fs';

import { buildSubprocessNetworkEnv } from '@/core/host/connectivity/network-config.ts';
import {
  SECRETS_CALLER_COMMANDS,
  type SecretsCallerCommand,
} from '@/core/telemetry/secrets-analysis-telemetry.ts';
import { emitAnalysisCompleted } from '@/core/telemetry/telemetry-events.ts';
import { blank, print, success, warn } from '@/core/ui';
import { green, yellow } from '@/core/ui/colors.ts';

import type { ResolvedAuth } from '../../lib/auth-resolver.ts';
import logger from '../../lib/logger.ts';
import type { SpawnResult, StdioMode } from '../../lib/process.ts';
import { spawnProcessWithTimeout } from '../../lib/process.ts';
import { CommandFailedError, InvalidOptionError } from '../_common/error.ts';
import { installSecretsBinary } from '../_common/install/secrets.ts';

export interface AnalyzeSecretsOptions {
  paths?: string[];
  stdin?: boolean;
  /** Defaults to {@link SECRETS_CALLER_COMMANDS.analyzeSecrets}. Bare `analyze` passes `analyze`. */
  telemetryCallerCommand?: SecretsCallerCommand;
}

/** A single finding from sonar-secrets `--json` output. */
export interface SecretsJsonIssue {
  ruleKey: string;
  description: string;
  file?: string;
  location?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  maskedSecret?: string;
}

/** Top-level structure of sonar-secrets `--json` stdout. */
export interface SecretsJsonOutput {
  issues: SecretsJsonIssue[];
  errors?: string[];
}

/**
 * Safely parses sonar-secrets `--json` stdout. Returns an empty issue list on
 * parse failure so callers never have to guard against corrupt output.
 *
 * The binary emits errors[] as objects ({ message: string }), not plain strings.
 * We normalise them to strings at the parse boundary so callers don't care.
 */
export function parseSecretsJson(stdout: string): SecretsJsonOutput {
  try {
    const parsed = JSON.parse(stdout) as {
      issues?: unknown;
      errors?: Array<{ message?: string } | string | null>;
    };
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors
          .map((e) => (typeof e === 'string' ? e : e?.message))
          .filter((m): m is string => typeof m === 'string' && m.length > 0)
      : undefined;
    const issues = Array.isArray(parsed.issues)
      ? (parsed.issues as unknown[]).filter(
          (i): i is SecretsJsonIssue =>
            typeof i === 'object' &&
            i !== null &&
            typeof (i as Record<string, unknown>).description === 'string' &&
            typeof (i as Record<string, unknown>).ruleKey === 'string',
        )
      : [];
    return { issues, errors };
  } catch (err) {
    logger.debug(`parseSecretsJson: failed to parse stdout: ${(err as Error).message}`);
    return { issues: [] };
  }
}

/**
 * Emits a single CliAnalysisCompleted event for one sonar-secrets run, carrying `details`
 * (JSON-encoded blob when findings were reported, `""` otherwise). Telemetry write failures
 * are swallowed by the emit helper.
 *
 * Pass `result: null` for a run that failed to execute (spawn error or timeout): the completed
 * event is emitted with `exit_code: null` and `failures_count: 1` so failed-to-run scans are
 * still counted. Prefer {@link scanAndEmitSecrets}, which handles both outcomes for callers.
 */
async function emitSecretsRunTelemetry(
  callerCommand: SecretsCallerCommand,
  auth: ResolvedAuth,
  result: { exitCode: number | null; stdout: string } | null,
  durationMs: number,
): Promise<SecretsJsonOutput> {
  const parsed = result ? parseSecretsJson(result.stdout) : { issues: [] };

  const { issues, errors } = parsed;
  const exitCode = result?.exitCode ?? null;
  // Per-invocation failure flag (0/1): 1 when the scan did not produce a valid result — it
  // failed to run (null exit code) or exited with a non-clean, non-findings code.
  const failuresCount = exitCode === 0 || exitCode === EXIT_CODE_SECRETS_FOUND ? 0 : 1;
  const analysisId = randomUUID();

  let details = '';
  if (issues.length > 0) {
    const countsByRule: Record<string, number> = {};
    const filesWithFindings = new Set<string>();
    for (const issue of issues) {
      countsByRule[issue.ruleKey] = (countsByRule[issue.ruleKey] ?? 0) + 1;
      if (issue.file) filesWithFindings.add(issue.file);
    }
    const source: 'files' | 'stdin' = filesWithFindings.size > 0 ? 'files' : 'stdin';
    details = JSON.stringify({
      counts_by_rule: countsByRule,
      files_with_findings_count: filesWithFindings.size,
      source,
    });
  }

  await emitAnalysisCompleted(auth, {
    caller_command: callerCommand,
    analyzer: 'sonar-secrets',
    analysis_id: analysisId,
    findings_count: issues.length,
    exit_code: exitCode,
    errors_count: errors?.length ?? 0,
    failures_count: failuresCount,
    scan_duration_ms: durationMs,
    details,
  });

  return parsed;
}

/**
 * Runs one sonar-secrets spawn and emits CliAnalysisCompleted for either outcome:
 *  - the process ran (any exit code) → telemetry via {@link emitSecretsRunTelemetry};
 *  - the process failed to run (spawn error or timeout, i.e. the promise rejected) →
 *    a failures_count:1 event with exit_code null, then the error is re-thrown.
 *
 * Re-throwing preserves each caller's own fail-open / fail-closed / block handling; because the
 * emit happens first, failed runs are recorded even when the caller then throws (e.g. git hooks
 * failing closed under environment-based auth).
 */
export async function scanAndEmitSecrets(
  callerCommand: SecretsCallerCommand,
  auth: ResolvedAuth,
  run: () => Promise<SpawnResult>,
): Promise<{ result: SpawnResult; parsed: SecretsJsonOutput }> {
  const start = performance.now();
  try {
    const result = await run();
    const parsed = await emitSecretsRunTelemetry(
      callerCommand,
      auth,
      result,
      Math.round(performance.now() - start),
    );
    return { result, parsed };
  } catch (err) {
    await emitSecretsRunTelemetry(
      callerCommand,
      auth,
      null,
      Math.round(performance.now() - start),
    ).catch(() => undefined);
    throw err;
  }
}

interface ScanDisplayContext {
  paths: string[]; // empty = stdin mode
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
  return spawnProcessWithTimeout(
    binaryPath,
    ['--non-interactive', '--json', ...files],
    {
      stdin,
      stdout: 'pipe',
      stderr: 'pipe',
      env: buildAuthEnv(auth),
    },
    SCAN_TIMEOUT_MS,
    `Scan timed out after ${SCAN_TIMEOUT_MS}ms`,
  );
}

/**
 * Run sonar-secrets binary on arbitrary text via stdin (--input mode). Returns the full spawn result.
 */
export async function runSecretsBinaryOnText(
  binaryPath: string,
  text: string,
  auth: ResolvedAuth,
): Promise<SpawnResult> {
  return spawnProcessWithTimeout(
    binaryPath,
    ['--input', '--json'],
    {
      stdin: 'pipe',
      stdinData: text,
      stdout: 'pipe',
      stderr: 'pipe',
      env: buildAuthEnv(auth),
    },
    SCAN_TIMEOUT_MS,
    `Scan timed out after ${SCAN_TIMEOUT_MS}ms`,
  );
}

function buildAuthEnv(auth: ResolvedAuth): Record<string, string> {
  return {
    ...buildSubprocessNetworkEnv(),
    [BINARY_AUTH_URL_ENV]: auth.serverUrl,
    [BINARY_AUTH_TOKEN_ENV]: auth.token,
  };
}

async function handleCheckCommand(
  options: AnalyzeSecretsOptions,
  auth: ResolvedAuth,
): Promise<void> {
  validateScanOptions(options);
  const binaryPath = await installSecretsBinary();
  const scanStartTime = Date.now();
  const callerCommand = options.telemetryCallerCommand ?? SECRETS_CALLER_COMMANDS.analyzeSecrets;

  if (options.stdin) {
    const { result, parsed } = await scanAndEmitSecrets(callerCommand, auth, () =>
      runSecretsBinary(binaryPath, ['--input'], auth, 'inherit'),
    );
    reportScanResult(result, parsed, scanStartTime, { paths: [] });
  } else {
    await performPathsScan(binaryPath, options.paths ?? [], auth, scanStartTime, callerCommand);
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
  callerCommand: SecretsCallerCommand,
): Promise<void> {
  if (paths.length === 0) {
    throw new InvalidOptionError('At least one path is required');
  }

  for (const p of paths) {
    if (!existsSync(p)) {
      throw new InvalidOptionError(`Path not found: ${p}`);
    }
  }

  const { result, parsed } = await scanAndEmitSecrets(callerCommand, auth, () =>
    runSecretsBinary(binaryPath, paths, auth),
  );
  reportScanResult(result, parsed, scanStartTime, { paths });
}

function reportScanResult(
  result: SpawnResult,
  parsed: SecretsJsonOutput,
  scanStartTime: number,
  context: ScanDisplayContext,
): void {
  const scanDurationMs = Date.now() - scanStartTime;
  const exitCode = result.exitCode ?? 1;
  if (exitCode === 0) {
    handleScanSuccess(parsed, scanDurationMs, context);
  } else {
    handleScanFailure(result, parsed, scanDurationMs, exitCode);
  }
}

function handleScanSuccess(
  parsed: SecretsJsonOutput,
  scanDurationMs: number,
  context: ScanDisplayContext,
): void {
  blank();
  const { errors } = parsed;
  const displayPaths = context.paths.length > 0 ? context.paths : ['(stdin)'];
  for (const p of displayPaths) {
    print(`  ${green('✓')}  ${p}`);
  }
  warnScanErrors(errors);
  blank();
  success(`No issues found · ${scanDurationMs}ms`);
}

function displaySecretsFindings(issues: SecretsJsonIssue[]): void {
  const groups = new Map<string, SecretsJsonIssue[]>();
  for (const issue of issues) {
    const key = issue.file ?? '(stdin)';
    const existing = groups.get(key);
    if (existing) {
      existing.push(issue);
    } else {
      groups.set(key, [issue]);
    }
  }

  let first = true;
  for (const [file, fileIssues] of groups) {
    if (!first) blank();
    first = false;
    print(`  ${yellow('!')}  ${file}`);
    fileIssues.forEach((issue, idx) => {
      print(formatSecretsIssueLine(issue, idx + 1));
    });
  }
}

function formatSecretsIssueLine(issue: SecretsJsonIssue, index: number): string {
  const linePart = issue.location ? `line ${issue.location.startLine}` : '';
  const parts = [
    `[${index}]`,
    linePart,
    issue.description,
    issue.maskedSecret,
    issue.ruleKey,
  ].filter(Boolean);
  return `     ${parts.join('  ')}`;
}

export function warnScanErrors(errors?: string[]): void {
  if (!errors?.length) return;
  for (const msg of errors) {
    warn(`  Scan warning: ${msg}`);
  }
}

function handleScanFailure(
  result: { stderr: string; stdout: string },
  parsed: SecretsJsonOutput,
  scanDurationMs: number,
  exitCode: number,
): void {
  blank();

  if (exitCode === EXIT_CODE_SECRETS_FOUND) {
    const { issues, errors } = parsed;
    if (issues.length > 0) {
      displaySecretsFindings(issues);
      blank();
    } else if (result.stderr) {
      print(result.stderr);
      blank();
    }
    warnScanErrors(errors);
    const count = issues.length;
    const secretWord = count === 1 ? 'secret' : 'secrets';
    // count === 0 means exit 51 but no parseable issues — report generically.
    const message =
      count === 0
        ? `Secrets found · ${scanDurationMs}ms`
        : `${count} ${secretWord} found · ${scanDurationMs}ms`;
    const hintWord = count === 0 ? 'secret(s)' : secretWord;
    throw new CommandFailedError(message, {
      exitCode,
      remediationHint: `Remove the reported ${hintWord}, then rerun the scan.`,
    });
  }

  const output = [result.stderr, result.stdout].filter(Boolean).join('\n');
  if (output) {
    print(output);
    blank();
  }

  throw new CommandFailedError(`Scan error (exit code ${exitCode})`, {
    exitCode,
    remediationHint: "Run 'sonar integrate' to reinstall the secrets analyzer, then retry.",
  });
}

function handleScanError(err: unknown): void {
  if (err instanceof InvalidOptionError || err instanceof CommandFailedError) {
    throw err;
  }

  const errorMessage = (err as Error).message;

  let details: string;
  if (errorMessage.includes('timed out')) {
    details = 'Try scanning a smaller file or check system resources.';
  } else if (errorMessage.includes('ENOENT')) {
    details = "Run 'sonar integrate' to reinstall the secrets analyzer, then retry.";
  } else {
    details =
      "Make sure the secrets analyzer is installed and executable on this machine; if needed, rerun 'sonar integrate', then retry.";
  }

  throw new CommandFailedError(`Error: ${errorMessage}`, { remediationHint: details });
}
