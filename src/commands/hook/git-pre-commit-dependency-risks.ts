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

// Dependency-risks stage of the git pre-commit hook. Invoked after the secrets
// stage when the user opted in via `--dependency-risks` and `-p <projectKey>`. Skips
// silently when no manifests changed, fails-open on infra errors (auth/binary
// missing, scanner failure), and blocks the commit only when risks matching the
// configured filter are found.

import {
  recordScaAnalysisTelemetry,
  SCA_CALLER_COMMANDS,
} from '@/commands/analyze/sca-analysis-telemetry.ts';
import type { CommandInvocationContext } from '@/commands/command-invocation-context.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import {
  resolveScaScannerBinaryPath,
  ScaScannerNoopInstaller,
} from '@/core/host/install/sca-scanner.ts';
import { ResolveOnlySecretsInstaller } from '@/core/host/install/secrets.ts';
import logger from '@/core/observability/logger.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import { discreetSuccess, success, warn } from '@/core/ui';

import { countSelectedRisks } from '../analyze/dependency-risk-helpers/count-selected-risks.ts';
import { DefaultScaScannerSpawner } from '../analyze/dependency-risk-helpers/default-sca-scanner-spawner.ts';
import { pluralize } from '../analyze/dependency-risk-helpers/pluralize.ts';
import { buildRiskFilter } from '../analyze/dependency-risk-helpers/risk-filter.ts';
import {
  ScaScanOrchestrator,
  type ScaScanResult,
} from '../analyze/dependency-risk-helpers/sca-scan-orchestrator.ts';
import type { Severity } from '../analyze/dependency-risk-helpers/sca-scanner.ts';
import {
  anyFileMatches,
  ScaWatchPatternsRunner,
} from '../analyze/dependency-risk-helpers/sca-watch-patterns.ts';
import type { DependencyRisksViewModel } from '../analyze/dependency-risk-helpers/view-model';
import { buildDependencyRisksViewModel } from '../analyze/dependency-risk-helpers/view-model/build';
import { SEVERITIES } from '../analyze/dependency-risk-helpers/view-model/build/severity.ts';

const HOOK_STATUS_FILTER = 'new';
const HOOK_MIN_SEVERITY: Severity = 'MEDIUM';

export interface DepRisksStageOptions {
  project: string;
  changedFiles: string[];
  auth: ResolvedAuth;
  ctx: CommandInvocationContext;
}

export async function runDepRisksStage(options: DepRisksStageOptions): Promise<void> {
  const binaryPath = resolveScaScannerBinaryPath();
  if (!binaryPath) {
    logger.warn('Dependency-risks hook: sca-scanner binary not installed, skipping.');
    warn(
      "Dependency-risks scan skipped: sca-scanner binary not installed; commit not blocked. Re-run 'sonar integrate git -p <project>' to restore it.",
    );
    return;
  }

  if (!(await shouldRunDependencyRiskAnalysis(binaryPath, options.changedFiles))) {
    return;
  }

  const filter = buildRiskFilter(HOOK_STATUS_FILTER, HOOK_MIN_SEVERITY);
  if (!filter) {
    warn(
      `Dependency-risks hook: invalid filter (statuses='${HOOK_STATUS_FILTER}'); commit not blocked.`,
    );
    return;
  }

  let scan: ScaScanResult;
  let viewModel: DependencyRisksViewModel;
  try {
    const client = new SonarQubeClient(options.auth.serverUrl, options.auth.token);
    scan = await new ScaScanOrchestrator(
      client,
      new ScaScannerNoopInstaller(binaryPath),
      new DefaultScaScannerSpawner(),
      new ResolveOnlySecretsInstaller(),
    ).run(options.auth, options.project, SCA_CALLER_COMMANDS.gitPreCommit, options.ctx);
    viewModel = buildDependencyRisksViewModel(scan.response, filter);
  } catch (err) {
    // The orchestrator already emitted a failures_count:1 event if the SCA scan itself failed;
    // a secrets pre-scan abort also lands here and must NOT be recorded as an SCA failure.
    warn(`Dependency-risks scan failed; commit not blocked. Reason: ${(err as Error).message}`);
    return;
  }

  // Hook has no analyze-style 0/1/51 exit code, so exit_code is null.
  recordScaAnalysisTelemetry(
    options.ctx,
    options.auth,
    SCA_CALLER_COMMANDS.gitPreCommit,
    scan.response,
    scan.scanDurationMs,
    null,
  );

  const matchedCount = countSelectedRisks(viewModel);
  if (matchedCount === 0) {
    discreetSuccess('No dependency risks found.');
    return;
  }

  throw new CommandFailedError(
    `${matchedCount} dependency ${pluralize(matchedCount, 'risk')} found (${formatSeverityBreakdown(viewModel)})`,
    {
      remediationHint: `Run 'sonar analyze dependency-risks -p ${options.project}' for details and fix recommendations. Bypass with 'git commit --no-verify' if risks are already reviewed.`,
    },
  );
}

function formatSeverityBreakdown(viewModel: DependencyRisksViewModel): string {
  return SEVERITIES.map((severity) => ({
    severity,
    count: countSelectedRisks(viewModel, (risk) => risk.severity === severity),
  }))
    .filter(({ count }) => count > 0)
    .map(({ severity, count }) => `${count} ${severity}`)
    .join(', ');
}

async function shouldRunDependencyRiskAnalysis(binaryPath: string, changedFiles: string[]) {
  const patterns = await new ScaWatchPatternsRunner(
    new ScaScannerNoopInstaller(binaryPath),
    new DefaultScaScannerSpawner(),
  ).run();
  if (patterns.length === 0) {
    logger.debug('Dependency-risks hook: no watch patterns returned, skipping.');
    return false;
  }

  if (!anyFileMatches(changedFiles, patterns)) {
    success('No dependency manifests changed in this commit — skipping dependency-risks scan.');
    return false;
  }

  return true;
}
