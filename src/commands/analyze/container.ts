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

import { CommandFailedError, remediationHintFor } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { installContainerScanner } from '@/core/host/install/container-scanner.ts';
import { ProcessTimedOutError } from '@/core/process/process.ts';

import {
  containerScanErrorReport,
  formatContainerScanJson,
  parseContainerScanReport,
} from './container-scanner-report.ts';
import {
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

export async function analyzeContainer(
  image: string,
  options: AnalyzeContainerOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const env = await prepareContainerScannerEnv(ctx.auth);
  const result = await installContainerScanner(ctx.console)
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Could not install the container scanner.';
      throw new CommandFailedError(message, { cause: error });
    })
    .then((binary) => runContainerScanner(binary, image, options, env))
    .catch((error: unknown) => ({
      exitCode: null,
      stdout: '',
      stderr: '',
      executionFailure: {
        message:
          error instanceof ProcessTimedOutError || error instanceof CommandFailedError
            ? error.message
            : 'Could not start the container scanner.',
        exitCode: error instanceof ContainerScanCancelledError ? error.exitCode : (1 as const),
        remediationHint: remediationHintFor(error),
      },
    }));

  const scannerReport = parseContainerScanReport(result);
  const executionFailure = 'executionFailure' in result ? result.executionFailure : undefined;
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
  const redact = (message: string): string => message.replaceAll(ctx.auth.token, '[redacted]');
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

  if (options.format === 'table') {
    ctx.console.print(formatContainerScanTable(report, stderr));
  } else {
    const errors = report.errors.map((error) => ({ ...error, message: redact(error.message) }));
    ctx.console.print(formatContainerScanJson({ ...report, errors }));
  }
  process.exitCode = report.exitCode;
}
