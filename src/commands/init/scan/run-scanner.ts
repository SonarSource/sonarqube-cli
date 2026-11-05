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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { DEFAULT_ANALYSIS_TIMEOUT_SECONDS } from '@/core/commands/poll.ts';
import { LOG_DIR, OWNER_ONLY_FILE_MODE } from '@/core/config-constants.ts';
import {
  type ScannerInstallation,
  scannerJavaArgs,
} from '@/core/host/install/scanner-discovery.ts';
import { parseProperties } from '@/core/io/properties.ts';
import logger from '@/core/observability/logger.ts';
import { spawnDetachedToLog, spawnProcessWithTimeout } from '@/core/process/process.ts';

/** Values shorter than this are left alone when redacting: they would garble unrelated output. */
const MIN_REDACTED_VALUE_LENGTH = 4;

/** Command-line properties beat every file, so a project cannot make a detached scanner verbose. */
const QUIET_ARGUMENTS = ['-Dsonar.verbose=false', '-Dsonar.log.level=INFO'];

export interface ScannerRun {
  scanner: ScannerInstallation;
  projectRoot: string;
  projectKey: string;
  auth: ResolvedAuth;
  /** Scratch directory for the scanner's working files and report. */
  directory: string;
  /** Proxy and TLS settings, from {@link scannerNetworkEnv}. */
  networkEnv: NodeJS.ProcessEnv;
  scannerProperties: Map<string, string>;
}

export interface ScannerOutputSink {
  print(line: string): void;
}

export interface ScanOutcome {
  taskId: string;
  logPath: string;
}

function newLogPath(): string {
  mkdirSync(LOG_DIR, { recursive: true });
  return join(LOG_DIR, `sonar-scanner-${randomUUID()}.log`);
}

function writeLogHeader(logPath: string, run: ScannerRun): void {
  writeFileSync(logPath, `SonarScanner ${run.scanner.version}\nProject: ${run.projectKey}\n\n`, {
    mode: OWNER_ONLY_FILE_MODE,
  });
}

/** The command line carries no secret and no user-supplied value; those travel in the environment. */
function scannerArguments(run: ScannerRun, reportPath: string): string[] {
  const { auth } = run;
  const args = [
    ...scannerJavaArgs(run.scanner, run.projectRoot),
    `-Dsonar.host.url=${auth.serverUrl}`,
    `-Dsonar.projectKey=${run.projectKey}`,
    `-Dsonar.projectBaseDir=${run.projectRoot}`,
    `-Dsonar.working.directory=${join(run.directory, 'work')}`,
    `-Dsonar.scanner.metadataFilePath=${reportPath}`,
    '-Dsonar.qualitygate.wait=false',
    '-Dsonar.scanner.autoconfig.enabled=true',
  ];
  if (auth.orgKey) {
    args.push(`-Dsonar.organization=${auth.orgKey}`);
  }
  return args;
}

function scannerEnvironment(run: ScannerRun): NodeJS.ProcessEnv {
  return {
    ...run.networkEnv,
    SONAR_SCANNER_JSON_PARAMS: JSON.stringify(Object.fromEntries(run.scannerProperties)),
    SONAR_TOKEN: run.auth.token,
    SONAR_REGION: undefined,
  };
}

/** The scanner may echo a value JSON-escaped or URL-encoded, so those forms are redacted too. */
function secretForms(value: string): string[] {
  return [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)];
}

function redactor(run: ScannerRun): (text: string) => string {
  const token = secretForms(run.auth.token).filter((form) => form.length > 0);
  const properties = [...run.scannerProperties.values()]
    .filter((value) => value.length >= MIN_REDACTED_VALUE_LENGTH)
    .flatMap(secretForms);
  // Longest first, so a form that contains another is replaced whole.
  const secrets = [...new Set([...token, ...properties])].sort((a, b) => b.length - a.length);
  return (text) => secrets.reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), text);
}

/** Buffers chunks into whole lines, so a secret split across two chunks is still redacted. */
function lineEmitter(emit: (line: string) => void) {
  let pending = '';
  return {
    write(chunk: string) {
      pending += chunk;
      for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
        emit(pending.slice(0, end).replace(/\r$/, ''));
        pending = pending.slice(end + 1);
      }
    },
    finish() {
      if (pending) emit(pending);
      pending = '';
    },
  };
}

function resumeHint(logPath: string): string {
  return `Inspect ${logPath} for the scanner's diagnostics, fix the reported problem, then run the scanner again.`;
}

function readTaskId(reportPath: string, projectKey: string, logPath: string): string {
  let report: Map<string, string>;
  try {
    report = parseProperties(readFileSync(reportPath, 'utf8'));
  } catch (cause) {
    throw new CommandFailedError('SonarScanner did not produce an analysis task report.', {
      cause,
      remediationHint: resumeHint(logPath),
    });
  }
  const taskId = report.get('ceTaskId');
  if (!taskId || report.get('projectKey') !== projectKey) {
    throw new CommandFailedError('SonarScanner produced an invalid analysis task report.', {
      remediationHint: resumeHint(logPath),
    });
  }
  return taskId;
}

/**
 * Runs the scanner to completion without a shell. Its output goes to a log file, with the token and
 * the `--scanner-property` values redacted, and to `live` when given. Resolves to the id of the
 * server-side task that processes the upload.
 */
export async function runScanner(
  run: ScannerRun,
  live?: ScannerOutputSink,
  timeoutMs = DEFAULT_ANALYSIS_TIMEOUT_SECONDS * 1000,
): Promise<ScanOutcome> {
  const reportPath = join(run.directory, 'report-task.txt');
  const logPath = newLogPath();
  writeLogHeader(logPath, run);
  const redact = redactor(run);
  const emit = (source: 'stdout' | 'stderr') => (line: string) => {
    const safe = redact(line);
    try {
      appendFileSync(logPath, `[${source}] ${safe}\n`);
    } catch (error) {
      logger.debug(`Could not write to the scanner log: ${(error as Error).message}`);
    }
    live?.print(safe);
  };
  const stdout = lineEmitter(emit('stdout'));
  const stderr = lineEmitter(emit('stderr'));

  let exitCode: number | null;
  try {
    ({ exitCode } = await spawnProcessWithTimeout(
      run.scanner.javaPath,
      scannerArguments(run, reportPath),
      {
        cwd: run.projectRoot,
        env: scannerEnvironment(run),
        onStdout: (text) => {
          stdout.write(text);
        },
        onStderr: (text) => {
          stderr.write(text);
        },
      },
      timeoutMs,
      'SonarScanner timed out.',
    ));
  } catch (cause) {
    const message = redact(cause instanceof Error ? cause.message : String(cause));
    appendFileSync(logPath, `${message}\n`);
    throw new CommandFailedError(message, { cause, remediationHint: resumeHint(logPath) });
  } finally {
    stdout.finish();
    stderr.finish();
  }
  if (exitCode !== 0) {
    throw new CommandFailedError(`SonarScanner exited with code ${exitCode ?? 'unknown'}.`, {
      remediationHint: resumeHint(logPath),
    });
  }
  return { taskId: readTaskId(reportPath, run.projectKey, logPath), logPath };
}

/**
 * Starts the scanner in the background and returns at once. The log file receives the scanner's raw
 * output, unredacted: it echoes no property unless `sonar.verbose` or `sonar.log.level` raises its
 * verbosity. `validateScanFlags()` refuses those flags with `--detach`, and {@link QUIET_ARGUMENTS}
 * overrides the same settings from `sonar-project.properties` or the global scanner configuration.
 * Nothing watches the analysis, so no task id is read.
 */
export async function startScannerInBackground(
  run: ScannerRun,
): Promise<{ pid: number; logPath: string }> {
  const logPath = newLogPath();
  writeLogHeader(logPath, run);
  try {
    const pid = await spawnDetachedToLog(
      run.scanner.javaPath,
      [...scannerArguments(run, join(run.directory, 'report-task.txt')), ...QUIET_ARGUMENTS],
      { cwd: run.projectRoot, env: scannerEnvironment(run), logPath },
    );
    return { pid, logPath };
  } catch (cause) {
    throw new CommandFailedError('Could not start the SonarScanner in the background.', {
      cause,
      remediationHint: resumeHint(logPath),
    });
  }
}
