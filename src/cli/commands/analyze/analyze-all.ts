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

import type { Command } from 'commander';

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import {
  blank,
  getMessagesForFormattedOutput,
  print,
  setFormattedOutputMode,
  text,
} from '../../../ui';
import { resolveSecretsBinaryPath } from '../_common/install/secrets';
import { analyzeSecrets, EXIT_CODE_SECRETS_FOUND, runSecretsBinary } from './secrets';
import type { SecretsIssue } from './secrets-output';
import { parseSecretsOutput } from './secrets-output';
import type { OutputFormat } from './sqaa';
import { analyzeSqaa, buildSqaaJsonReport } from './sqaa';
import { resolveChangeSet } from './sqaa-changeset';
import { applyExitCode, makeReport, type SqaaJsonReport } from './sqaa-display';

export interface AnalyzeAllOptions {
  file?: string;
  staged?: boolean;
  base?: string;
  force?: boolean;
  format?: OutputFormat;
}

interface SecretsReport {
  issues: SecretsIssue[];
  summary: { totalIssues: number };
  error?: string;
}

function secretsReport(issues: SecretsIssue[], error?: string): SecretsReport {
  const report: SecretsReport = { issues, summary: { totalIssues: issues.length } };
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
export async function analyzeAll(
  options: AnalyzeAllOptions,
  auth: ResolvedAuth,
  command?: Command,
): Promise<void> {
  if (options.format === 'json') {
    return analyzeAllJson(options, auth, command);
  }

  const { file, staged, base, force, format } = options;

  if (file !== undefined) {
    await analyzeSecrets({ paths: [file] }, auth);
    await analyzeSqaa({ file, format }, auth, command);
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

  await analyzeSecrets({ paths: changeSet.files }, auth);
  // analyzeSqaa resolves the change set again internally. The two resolutions may
  // cover slightly different sets if the working tree changes between calls — this
  // is acceptable since the analyses are independent and best-effort.
  await analyzeSqaa({ staged, base, force, format }, auth, command);
}

async function analyzeAllJson(
  options: AnalyzeAllOptions,
  auth: ResolvedAuth,
  command?: Command,
): Promise<void> {
  setFormattedOutputMode(true);
  try {
    const { file, staged, base } = options;

    if (file !== undefined) {
      await runSecretsAndAgentic([file], options, auth, command);
      return;
    }

    const changeSet = await resolveChangeSet(process.cwd(), { staged, base });

    if (changeSet.files.length === 0) {
      printCombinedReport(secretsReport([]), makeReport([], [], changeSet.ignored));
      return;
    }

    await runSecretsAndAgentic(changeSet.files, options, auth, command);
  } finally {
    setFormattedOutputMode(false);
  }
}

async function runSecretsAndAgentic(
  files: string[],
  options: AnalyzeAllOptions,
  auth: ResolvedAuth,
  command?: Command,
): Promise<void> {
  const secrets = await runSecretsScan(files, auth);
  const secretsFailed = secrets !== null && secrets.exitCode !== 0;
  const agentic = secretsFailed ? null : await buildSqaaJsonReport(options, auth, command);

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

  const result = await runSecretsBinary(binaryPath, files, auth);
  const exitCode = result.exitCode ?? EXIT_CODE_SECRETS_FOUND;
  const issues = parseSecretsOutput(result.stdout);
  // When the binary crashes (not EXIT_CODE_SECRETS_FOUND), parseSecretsOutput returns []
  // — surface an explicit error so the consumer can distinguish crash from "found secrets".
  const error =
    exitCode === EXIT_CODE_SECRETS_FOUND
      ? undefined
      : `secrets binary exited with unexpected code ${String(exitCode)}`;

  return { report: secretsReport(issues, error), exitCode };
}
