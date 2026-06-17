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

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import logger from '../../../lib/logger';
import { SonarQubeClient } from '../../../sonarqube/client';
import { discreetSuccess, success, warn } from '../../../ui';
import { CommandFailedError } from '../_common/error';
import {
  resolveScaScannerBinaryPath,
  ScaScannerNoopInstaller,
} from '../_common/install/sca-scanner';
import { ResolveOnlySecretsInstaller } from '../_common/install/secrets';
import { countSelectedRisks } from '../analyze/dependency-risk-helpers/count-selected-risks';
import { DefaultScaScannerSpawner } from '../analyze/dependency-risk-helpers/default-sca-scanner-spawner';
import { pluralize } from '../analyze/dependency-risk-helpers/pluralize';
import { buildRiskFilter } from '../analyze/dependency-risk-helpers/risk-filter';
import { ScaScanOrchestrator } from '../analyze/dependency-risk-helpers/sca-scan-orchestrator';
import {
  anyFileMatches,
  ScaWatchPatternsRunner,
} from '../analyze/dependency-risk-helpers/sca-watch-patterns';
import type { DependencyRisksViewModel } from '../analyze/dependency-risk-helpers/view-model';
import { buildDependencyRisksViewModel } from '../analyze/dependency-risk-helpers/view-model/build';
import { SEVERITIES } from '../analyze/dependency-risk-helpers/view-model/build/severity';

const HOOK_STATUS_FILTER = 'new';

export interface DepRisksStageOptions {
  project: string;
  changedFiles: string[];
  auth: ResolvedAuth;
}

export async function runDepRisksStage(options: DepRisksStageOptions): Promise<void> {
  const binaryPath = resolveScaScannerBinaryPath();
  if (!binaryPath) {
    logger.debug('Dependency-risks hook: sca-scanner binary not installed, skipping.');
    return;
  }

  if (!(await shouldRunDependencyRiskAnalysis(binaryPath, options.changedFiles))) {
    return;
  }

  const filter = buildRiskFilter(HOOK_STATUS_FILTER);
  if (!filter) {
    warn(
      `Dependency-risks hook: invalid filter (statuses='${HOOK_STATUS_FILTER}'); commit not blocked.`,
    );
    return;
  }

  let viewModel;
  try {
    const client = new SonarQubeClient(options.auth.serverUrl, options.auth.token);
    const result = await new ScaScanOrchestrator(
      client,
      new ScaScannerNoopInstaller(binaryPath),
      new DefaultScaScannerSpawner(),
      new ResolveOnlySecretsInstaller(),
    ).run(options.auth, options.project);
    viewModel = buildDependencyRisksViewModel(result, filter);
  } catch (err) {
    warn(`Dependency-risks scan failed; commit not blocked. Reason: ${(err as Error).message}`);
    return;
  }

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
