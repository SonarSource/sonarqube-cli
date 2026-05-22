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

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ResolvedAuth } from '../../../lib/auth-resolver';
import { CLI_DIR } from '../../../lib/config-constants';
import logger, { getLogLevelConfig } from '../../../lib/logger';
import { SonarQubeClient } from '../../../sonarqube/client';
import { error, print, warn } from '../../../ui';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';
import { DefaultScaScannerInstaller } from '../_common/install/sca-scanner.ts';
import { parseAnalysisProperties } from './dependency-risk-helpers/analysis-properties.ts';
import { DefaultScaScannerSpawner } from './dependency-risk-helpers/default-sca-scanner-spawner.ts';
import { formatDependencyRisksJson } from './dependency-risk-helpers/format-dependency-risks-json.ts';
import { buildRiskFilter } from './dependency-risk-helpers/risk-filter.ts';
import {
  type ScaScannerInvocation,
  ScaScannerRunner,
} from './dependency-risk-helpers/sca-scanner.ts';
import { buildScaUrls } from './dependency-risk-helpers/sca-urls.ts';
import { formatDependencyRisksTable } from './dependency-risk-helpers/table';
import type { DependencyRisksViewModel } from './dependency-risk-helpers/view-model';
import { buildDependencyRisksViewModel } from './dependency-risk-helpers/view-model/build';

export const VALID_FORMATS = ['json', 'table'];

const EXIT_CODE_OK = 0;
const EXIT_CODE_ERRORS_ONLY = 1;
const EXIT_CODE_UNRESOLVED_RISKS = 51;

export interface AnalyzeDependencyRisksOptions {
  project: string;
  format: string;
  statuses: string;
}

export async function analyzeDependencyRisks(
  options: AnalyzeDependencyRisksOptions,
  auth: ResolvedAuth,
): Promise<void> {
  const filter = buildRiskFilter(options.statuses);
  if (!filter) {
    throw new InvalidOptionError(`Invalid --statuses value: '${options.statuses}'`);
  }

  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  const enabled = await client.checkScaEnabled(auth.connectionType, auth.orgKey);
  if (!enabled) {
    throw new CommandFailedError(
      'Software Composition Analysis is not available for the current server connection.',
      {
        remediationHint:
          'Use a connection where SCA is enabled, or verify your server edition, plan, and organization entitlements.',
      },
    );
  }

  const settings = await client.getProjectSettings(options.project);
  const properties = parseAnalysisProperties(settings);
  logger.debug(`Resolved analysis properties: ${JSON.stringify(properties)}`);

  const { apiBaseUrl, downloadBaseUrl } = buildScaUrls(auth);

  const invocation: ScaScannerInvocation = {
    baseDir: process.cwd(),
    apiBaseUrl,
    downloadBaseUrl,
    sonarToken: auth.token,
    projectKey: options.project,
    cacheDir: join(CLI_DIR, 'sca-scanner-cache'),
    workDir: join(tmpdir(), `sonar-sca-${Date.now()}`),
    scannerProperties: properties.scaProperties,
    excludedPaths: properties.exclusions,
    includeGitIgnoredPaths: properties.includeGitIgnoredPaths,
    debug: getLogLevelConfig() === 'DEBUG',
  };

  const result = await new ScaScannerRunner(
    new DefaultScaScannerInstaller(),
    new DefaultScaScannerSpawner(),
  ).run(invocation);

  const viewModel = buildDependencyRisksViewModel(result, filter);
  if (options.format === 'json') {
    print(formatDependencyRisksJson(options.project, viewModel));
  } else {
    print(formatDependencyRisksTable(viewModel));
  }

  handleResult(countUnresolvedIssues(viewModel), result.errors.length);
}

function handleResult(unresolvedRisksCount: number, errorCount: number) {
  function warnErrorsDuringAnalysis() {
    if (errorCount > 0) {
      warn(`Found ${errorCount} ${pluralize(errorCount, 'analysis error')}.`);
    }
  }

  if (unresolvedRisksCount > 0) {
    warnErrorsDuringAnalysis();
    error(
      `Found ${unresolvedRisksCount} ${pluralize(unresolvedRisksCount, 'unresolved dependency risk')}.`,
    );
    process.exitCode = EXIT_CODE_UNRESOLVED_RISKS;
  } else if (errorCount > 0) {
    warnErrorsDuringAnalysis();
    process.exitCode = EXIT_CODE_ERRORS_ONLY;
  } else {
    process.exitCode = EXIT_CODE_OK;
  }
}

function pluralize(count: number, singular: string): string {
  return `${singular}${count === 1 ? '' : 's'}`;
}

export function countUnresolvedIssues(vm: DependencyRisksViewModel): number {
  const isUnresolved = buildRiskFilter('active')!.predicate;
  let count = 0;
  for (const pkg of vm.packages) {
    for (const group of pkg.groups) {
      for (const risk of group.selectedRisks) {
        if (isUnresolved(risk)) count += 1;
      }
    }
  }
  return count;
}
