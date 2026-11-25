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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import {
  type CommandAuthenticatedInvocationContext,
  TelemetryFact,
} from '@/core/commands/invocation-context.ts';
import { installContainerScanner } from '@/core/host/install/container-scanner.ts';
import { ProcessTimedOutError } from '@/core/process/process.ts';

import { type AnalysisCompletedPayload, CLI_ANALYSIS_COMPLETED } from './analysis-completed.ts';
import {
  containerScanErrorReport,
  countContainerAnalysisErrors,
  formatContainerScanJson,
  formatContainerScanTable,
  parseContainerScanReport,
  sanitizeScannerTerminalText,
} from './container-scanner-report.ts';
import {
  ContainerScanCancelledError,
  type ContainerScanOptions,
  prepareContainerScannerEnv,
  runContainerScanner,
} from './container-scanner-runner.ts';

export const CONTAINER_SCAN_FORMATS = ['json', 'table'] as const;

export interface AnalyzeContainerOptions extends ContainerScanOptions {
  format: (typeof CONTAINER_SCAN_FORMATS)[number];
}

export async function analyzeContainer(
  image: string,
  options: AnalyzeContainerOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const env = await prepareContainerScannerEnv(ctx.auth);
  const binary = await installContainerScanner(ctx.console);
  const startedAt = performance.now();
  const result = await runContainerScanner(binary, image, options, env).catch((error: unknown) => ({
    exitCode: null,
    stdout: '',
    stderr: '',
    launchFailure: {
      message:
        error instanceof ProcessTimedOutError || error instanceof CommandFailedError
          ? error.message
          : 'Could not start the container scanner.',
      exitCode: error instanceof ContainerScanCancelledError ? error.exitCode : (1 as const),
    },
  }));

  const scanDurationMs = Math.round(performance.now() - startedAt);
  const scannerReport = parseContainerScanReport(result);
  const launchFailure = 'launchFailure' in result ? result.launchFailure : undefined;
  const report =
    scannerReport ??
    containerScanErrorReport(
      image,
      options,
      {
        kind: launchFailure ? 'scannerExecution' : 'invalidScannerReport',
        message: launchFailure?.message ?? 'The container scanner did not return a valid report.',
      },
      launchFailure?.exitCode,
    );
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
  const redact = (message: string): string => message.replaceAll(ctx.auth.token, '[redacted]');
  const terminalText = (message: string): string =>
    redact(sanitizeScannerTerminalText(redact(message)));
  const stderr = terminalText(result.stderr).trimEnd();
  if (stderr) ctx.console.print(stderr, 'stderr');

  if (!scannerReport || (report.exitCode === 1 && !stderr)) {
    const message = terminalText(report.errors[0]?.message ?? '').trim();
    ctx.console.error(message || 'Container scan failed.');
  }

  if (options.format === 'table') {
    ctx.console.print(formatContainerScanTable(report, stderr));
  } else {
    const errors = report.errors.map((error) => ({ ...error, message: redact(error.message) }));
    ctx.console.print(formatContainerScanJson({ ...report, errors }));
  }
  process.exitCode = report.exitCode;
}
