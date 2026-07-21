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
  blank,
  getMessagesForFormattedOutput,
  print,
  setFormattedOutputMode,
  text,
} from '../../core/ui';
import type { ResolvedAuth } from '../../lib/auth-resolver.ts';
import { SECRETS_CALLER_COMMANDS } from '../../telemetry/secrets-analysis-telemetry.ts';
import { SQAA_ANALYZE_CALLER_COMMAND } from '../../telemetry/sqaa-analysis-telemetry.ts';
import { resolveSecretsBinaryPath } from '../_common/install/secrets.ts';
import type { SecretsJsonIssue } from './secrets.ts';
import {
  analyzeSecrets,
  EXIT_CODE_SECRETS_FOUND,
  parseSecretsJson,
  runSecretsBinary,
  scanAndEmitSecrets,
} from './secrets.ts';
import type { OutputFormat } from './sqaa.ts';
import { analyzeSqaa, buildSqaaJsonReport } from './sqaa.ts';
import { resolveChangeSet } from './sqaa-changeset.ts';
import { applyExitCode, makeReport, type SqaaJsonReport } from './sqaa-display.ts';
import { resolveSqaaFileArgs } from './sqaa-file-arg.ts';

export interface AnalyzeAllOptions {
  file?: string[];
  staged?: boolean;
  base?: string;
  project?: string;
  force?: boolean;
  format?: OutputFormat;
  depth?: string;
}

interface SecretsReport {
  issues: SecretsJsonIssue[];
  summary: { totalIssues: number };
  warnings?: string[];
  error?: string;
}

function secretsReport(
  issues: SecretsJsonIssue[],
  warnings?: string[],
  error?: string,
): SecretsReport {
  const report: SecretsReport = { issues, summary: { totalIssues: issues.length } };
  if (warnings?.length) report.warnings = warnings;
  if (error !== undefined) report.error = error;
  return report;
}

function printCombinedReport(secrets: SecretsReport | null, agentic: SqaaJsonReport | null): void {
  print(JSON.stringify({ secrets, agentic, messages: getMessagesForFormattedOutput() }, null, 2));
}

/**
 * Run all available analyses sequentially: secrets scan first, then agentic analysis.
 * Fail-fast: if secrets fails the agentic step is skipped.
 *
 * In json mode, outputs a single combined JSON report including any informational messages.
 * In text mode, each analysis prints its own output sequentially.
 */
export async function analyzeAll(options: AnalyzeAllOptions, auth: ResolvedAuth): Promise<void> {
  if (options.format === 'json') {
    return analyzeAllJson(options, auth);
  }

  const { file: rawFiles, staged, base, project, force, format, depth } = options;

  if (rawFiles?.length) {
    const entries = resolveSqaaFileArgs(rawFiles);
    const paths = entries.map((e) => e.absolutePath);
    await analyzeSecrets({ paths, telemetryCallerCommand: SECRETS_CALLER_COMMANDS.analyze }, auth);
    await analyzeSqaa({ file: paths, project, force, format, depth }, auth, {
      requireProject: false,
      telemetryCallerCommand: SQAA_ANALYZE_CALLER_COMMAND,
    });
    return;
  }

  const changeSet = await resolveChangeSet(process.cwd(), { staged, base });

  if (changeSet.files.length === 0) {
    blank();
    text(
      'SonarQube Analysis: no files in the change set to analyze. ' +
        'Untracked files are included by default; if you expected files here, check your git status.',
    );
    return;
  }

  await analyzeSecrets(
    { paths: changeSet.files, telemetryCallerCommand: SECRETS_CALLER_COMMANDS.analyze },
    auth,
  );
  // analyzeSqaa resolves the change set again internally. The two resolutions may
  // cover slightly different sets if the working tree changes between calls — this
  // is acceptable since the analyses are independent and best-effort.
  // requireProject: false → bare `analyze` skips agentic gracefully when unconfigured.
  await analyzeSqaa({ staged, base, project, force, format, depth }, auth, {
    requireProject: false,
    telemetryCallerCommand: SQAA_ANALYZE_CALLER_COMMAND,
  });
}

async function analyzeAllJson(options: AnalyzeAllOptions, auth: ResolvedAuth): Promise<void> {
  setFormattedOutputMode(true);
  try {
    const { file: rawFiles, staged, base } = options;

    if (rawFiles?.length) {
      const entries = resolveSqaaFileArgs(rawFiles);
      await runSecretsAndAgentic(
        entries.map((e) => e.absolutePath),
        options,
        auth,
      );
      return;
    }

    const changeSet = await resolveChangeSet(process.cwd(), { staged, base });

    if (changeSet.files.length === 0) {
      printCombinedReport(secretsReport([]), makeReport([], [], changeSet.ignored));
      return;
    }

    await runSecretsAndAgentic(changeSet.files, options, auth);
  } finally {
    setFormattedOutputMode(false);
  }
}

async function runSecretsAndAgentic(
  files: string[],
  options: AnalyzeAllOptions,
  auth: ResolvedAuth,
): Promise<void> {
  const secrets = await runSecretsScan(files, auth);
  const secretsFailed = secrets !== null && secrets.exitCode !== 0;
  const agentic = secretsFailed
    ? null
    : await buildSqaaJsonReport(options, auth, {
        telemetryCallerCommand: SQAA_ANALYZE_CALLER_COMMAND,
      });

  printCombinedReport(secrets?.report ?? null, agentic);

  if (secretsFailed) {
    process.exitCode = secrets.exitCode;
  } else if (agentic) {
    applyExitCode(agentic.summary.totalIssues, agentic.summary.totalFailures);
  }
}

async function runSecretsScan(
  files: string[],
  auth: ResolvedAuth,
): Promise<{ report: SecretsReport; exitCode: number } | null> {
  const binaryPath = resolveSecretsBinaryPath();
  if (binaryPath === null) return null;

  const { result } = await scanAndEmitSecrets(SECRETS_CALLER_COMMANDS.analyze, auth, () =>
    runSecretsBinary(binaryPath, files, auth),
  );
  const exitCode = result.exitCode ?? EXIT_CODE_SECRETS_FOUND;
  const { issues, errors } = parseSecretsJson(result.stdout);
  // Exit 0 (clean) and EXIT_CODE_SECRETS_FOUND (secrets found) are both expected outcomes. Any
  // other exit code is a crash — parseSecretsJson returns [] there, so surface an explicit error
  // to distinguish a crash from a genuine "no findings" result.
  const error =
    exitCode === 0 || exitCode === EXIT_CODE_SECRETS_FOUND
      ? undefined
      : `secrets binary exited with unexpected code ${String(exitCode)}`;

  return { report: secretsReport(issues, errors, error), exitCode };
}
