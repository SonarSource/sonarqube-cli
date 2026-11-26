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

import { CommandFailedError, remediationHintFor } from '@/core/commands/command-error.ts';
import {
  type CommandAuthenticatedInvocationContext,
  TelemetryFact,
} from '@/core/commands/invocation-context.ts';
import { installContainerScanner } from '@/core/host/install/container-scanner.ts';
import logger from '@/core/observability/logger.ts';
import { ProcessTimedOutError, type SpawnResult } from '@/core/process/process.ts';
import type { Console } from '@/core/ui/console.ts';

import { type AnalysisCompletedPayload, CLI_ANALYSIS_COMPLETED } from './analysis-completed.ts';
import {
  containerScanErrorReport,
  countContainerAnalysisErrors,
  formatContainerScanJson,
  parseContainerScanReport,
} from './container-scanner-report.ts';
import {
  type ContainerScanCancellationExitCode,
  ContainerScanCancelledError,
  type ContainerScanOptions,
  prepareContainerScannerEnv,
  runContainerScanner,
} from './container-scanner-runner.ts';
import {
  formatContainerScanTable,
  sanitizeScannerTerminalText,
} from './container-scanner-table.ts';

export const CONTAINER_SCAN_FORMATS = ['json', 'table'] as const;

// The pinned scanner ends successful scans with this summary on stderr.
const SCANNER_SUMMARY_PATTERN =
  /(?:^|\r?\n)(?:PASS|FAIL): \d+ finding\(s\), highest severity [a-z]+ \(fail-on: [a-z]+\)(?:\r?\n)?$/;

export interface AnalyzeContainerOptions extends ContainerScanOptions {
  format: (typeof CONTAINER_SCAN_FORMATS)[number];
}

interface ExecutionFailure {
  message: string;
  exitCode: 1 | ContainerScanCancellationExitCode;
  remediationHint?: string;
}

interface ContainerScanExecution {
  result: SpawnResult;
  executionFailure?: ExecutionFailure;
  scanDurationMs?: number;
}

const EMPTY_SPAWN_RESULT: SpawnResult = { exitCode: null, stdout: '', stderr: '' };

async function executeContainerScan(
  image: string,
  options: ContainerScanOptions,
  env: NodeJS.ProcessEnv,
  console: Console,
  redact: (message: string) => string,
): Promise<ContainerScanExecution> {
  let binary: string;
  try {
    binary = await installContainerScanner(console);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Could not install the container scanner.';
    logger.debug(`Container scanner installation failed: ${redact(message)}`);
    return {
      result: EMPTY_SPAWN_RESULT,
      executionFailure: {
        message,
        exitCode: 1,
        remediationHint: remediationHintFor(error),
      },
    };
  }

  const startedAt = performance.now();
  try {
    return {
      result: await runContainerScanner(binary, image, options, env),
      scanDurationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    const isKnownError =
      error instanceof ProcessTimedOutError || error instanceof CommandFailedError;
    if (!isKnownError) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.debug(`Could not start the container scanner: ${redact(detail)}`);
    }
    return {
      result: EMPTY_SPAWN_RESULT,
      scanDurationMs: Math.round(performance.now() - startedAt),
      executionFailure: {
        message: isKnownError ? error.message : 'Could not start the container scanner.',
        exitCode: error instanceof ContainerScanCancelledError ? error.exitCode : 1,
        remediationHint: remediationHintFor(error),
      },
    };
  }
}

export async function analyzeContainer(
  image: string,
  options: AnalyzeContainerOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const env = await prepareContainerScannerEnv(ctx.auth);
  const redact = (message: string): string =>
    ctx.auth.token ? message.replaceAll(ctx.auth.token, '[redacted]') : message;
  const { result, executionFailure, scanDurationMs } = await executeContainerScan(
    image,
    options,
    env,
    ctx.console,
    redact,
  );

  const scannerReport = parseContainerScanReport(result);
  const report =
    scannerReport ??
    containerScanErrorReport(
      image,
      options,
      {
        kind: executionFailure ? 'scannerExecution' : 'invalidScannerReport',
        message:
          executionFailure?.message ?? 'The container scanner did not return a valid report.',
      },
      executionFailure?.exitCode,
    );
  if (scanDurationMs !== undefined) {
    ctx.recordTelemetry(
      new TelemetryFact(
        CLI_ANALYSIS_COMPLETED,
        {
          analyzer: 'sonar-container-scanner',
          caller_command: 'analyze container',
          analysis_id: randomUUID(),
          findings_count: report.issues.length,
          errors_count: countContainerAnalysisErrors(report),
          failures_count: report.exitCode === 1 ? 1 : 0,
          exit_code: report.exitCode,
          scan_duration_ms: scanDurationMs,
          details: '',
        } satisfies AnalysisCompletedPayload,
        { auth: ctx.auth },
      ),
    );
  }
  const terminalText = (message: string): string =>
    redact(sanitizeScannerTerminalText(redact(message)));
  const scannerStderr =
    options.format === 'table' && scannerReport && scannerReport.exitCode !== 1
      ? result.stderr.replace(SCANNER_SUMMARY_PATTERN, '')
      : result.stderr;
  const stderr = terminalText(scannerStderr).trimEnd();
  if (stderr) ctx.console.print(stderr, 'stderr');

  if (!scannerReport || (report.exitCode === 1 && !stderr)) {
    const message = terminalText(report.errors[0]?.message ?? '').trim();
    ctx.console.error(message || 'Container scan failed.');
    if (executionFailure?.remediationHint) {
      ctx.console.print(`  → ${terminalText(executionFailure.remediationHint)}`, 'stderr');
    }
  }

  switch (options.format) {
    case 'table':
      ctx.console.print(formatContainerScanTable(report, result.stderr));
      break;
    case 'json': {
      const errors = report.errors.map((error) => ({ ...error, message: redact(error.message) }));
      ctx.console.print(formatContainerScanJson({ ...report, errors }));
      break;
    }
    default: {
      const _exhaustive: never = options.format;
      throw new CommandFailedError(`Unsupported container scan format: ${String(_exhaustive)}`);
    }
  }
  process.exitCode = report.exitCode;
}
