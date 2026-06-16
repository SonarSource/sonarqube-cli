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

import { type ResolvedAuth } from '../../../lib/auth-resolver';
import { discoverProject } from '../../../lib/project-workspace';
import { SonarQubeClient } from '../../../sonarqube/client';
import { error, print, warn } from '../../../ui';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';
import { DefaultScaScannerInstaller } from '../_common/install/sca-scanner.ts';
import { DefaultSecretsInstaller } from '../_common/install/secrets.ts';
import { countSelectedRisks } from './dependency-risk-helpers/count-selected-risks.ts';
import { DefaultScaScannerSpawner } from './dependency-risk-helpers/default-sca-scanner-spawner.ts';
import { formatDependencyRisksJson } from './dependency-risk-helpers/format-dependency-risks-json.ts';
import { formatDependencyRisksToon } from './dependency-risk-helpers/format-dependency-risks-toon.ts';
import { pluralize } from './dependency-risk-helpers/pluralize.ts';
import { buildRiskFilter } from './dependency-risk-helpers/risk-filter.ts';
import { ScaScanOrchestrator } from './dependency-risk-helpers/sca-scan-orchestrator.ts';
import { formatDependencyRisksTable } from './dependency-risk-helpers/table';
import type { DependencyRisksViewModel } from './dependency-risk-helpers/view-model';
import { buildDependencyRisksViewModel } from './dependency-risk-helpers/view-model/build';

export const VALID_FORMATS = ['json', 'toon', 'table'];

export const EXIT_CODE_UNRESOLVED_RISKS = 51;

const EXIT_CODE_OK = 0;
const EXIT_CODE_ERRORS_ONLY = 1;

export interface AnalyzeDependencyRisksOptions {
  project?: string;
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

  const projectKey = await resolveProjectKey(options.project, auth);

  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  const result = await new ScaScanOrchestrator(
    client,
    new DefaultScaScannerInstaller(),
    new DefaultScaScannerSpawner(),
    new DefaultSecretsInstaller(),
  ).run(auth, projectKey);

  const viewModel = buildDependencyRisksViewModel(result, filter);
  switch (options.format) {
    case 'json':
      print(formatDependencyRisksJson(projectKey, viewModel));
      break;
    case 'toon':
      print(formatDependencyRisksToon(projectKey, viewModel));
      break;
    default:
      print(formatDependencyRisksTable(viewModel));
  }

  handleResult(countUnresolvedIssues(viewModel), result.errors.length);
}

async function resolveProjectKey(
  explicitProject: string | undefined,
  auth: ResolvedAuth,
): Promise<string> {
  if (explicitProject) {
    print(`     Using project key: ${explicitProject}`, 'stderr');
    return explicitProject;
  }

  const discovered = await discoverProject(process.cwd(), true, { auth });
  if (discovered.projectKey) {
    print(`     Using auto-detected project key: ${discovered.projectKey}`, 'stderr');
    return discovered.projectKey;
  }

  throw new CommandFailedError('Could not determine project key.', {
    remediationHint:
      'Use --project <key>, add sonar.projectKey to sonar-project.properties, or configure a .sonarlint/ binding.',
  });
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

export function countUnresolvedIssues(vm: DependencyRisksViewModel): number {
  return countSelectedRisks(vm, buildRiskFilter('active')!.predicate);
}
