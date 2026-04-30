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

import { type ResolvedAuth, resolveFromEndpoint } from '../../../lib/auth-resolver';
import { CLI_DIR } from '../../../lib/config-constants';
import { getLogLevelConfig } from '../../../lib/logger';
import { SonarQubeClient } from '../../../sonarqube/client';
import { print } from '../../../ui';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';
import { MockScaScannerInstaller } from '../_common/install/sca-scanner.ts';
import {
  sortDependencyRisks,
  toDependencyRisks,
} from './dependency-risk-helpers/dependency-risk.ts';
import { formatDependencyRisksTable } from './dependency-risk-helpers/format-dependency-risks-table.ts';
import {
  type ScaScannerInvocation,
  ScaScannerRunner,
} from './dependency-risk-helpers/sca-scanner.ts';
import { MockScaScannerSpawner } from './dependency-risk-helpers/sca-scanner-spawner.ts';

export const VALID_FORMATS = ['json', 'table'];

export interface AnalyzeDependencyRisksOptions {
  project?: string;
  format?: string;
}

export async function analyzeDependencyRisks(
  options: AnalyzeDependencyRisksOptions,
  auth: ResolvedAuth,
): Promise<void> {
  if (!options.project) {
    throw new InvalidOptionError('--project is required');
  }

  const format = (options.format ?? 'table').toLowerCase();
  if (!VALID_FORMATS.includes(format)) {
    throw new InvalidOptionError(
      `Invalid format: '${options.format}'. Must be one of: ${VALID_FORMATS.join(', ')}`,
    );
  }

  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  const enabled = await client.checkScaEnabled(auth.connectionType, auth.orgKey);
  if (!enabled) {
    throw new CommandFailedError('Advanced Security not available');
  }

  const componentExists = await client.checkComponent(options.project);
  if (!componentExists) {
    throw new CommandFailedError(`No project: ${options.project}`);
  }

  const properties = await client.getProjectSettings(options.project);

  const invocation: ScaScannerInvocation = {
    baseDir: process.cwd(),
    // TODO(SCA wiring): --api-base-url is the executable-metadata host for
    // tidelift-cli, not the SonarQube /api endpoint. Replace once the backend
    // exposes the correct URL.
    apiBaseUrl: resolveFromEndpoint(auth.serverUrl, '/sca') + '/sca', // todo
    // TODO(SCA wiring): source --download-base-url from server config.
    downloadBaseUrl:
      auth.connectionType === 'cloud' ? 'https://scanner.sonarcloud.io/tidelift-cli' : '', // todo
    sonarToken: auth.token,
    projectKey: options.project,
    cacheDir: join(CLI_DIR, 'cache', 'sca-scanner'),
    workDir: join(tmpdir(), `sonar-sca-${Date.now()}`),
    scannerProperties: properties.scaProperties,
    excludedPaths: properties.exclusions,
    includeGitIgnoredPaths: properties.includeGitIgnoredPaths,
    debug: getLogLevelConfig() === 'DEBUG',
  };

  const result = await new ScaScannerRunner(
    new MockScaScannerInstaller(),
    new MockScaScannerSpawner(),
  ).run(invocation);

  const risks = sortDependencyRisks(toDependencyRisks(result));
  if (format === 'json') {
    print(JSON.stringify({ project: options.project, risks }, null, 2));
  } else {
    print(formatDependencyRisksTable(risks, result.packages.length));
  }
}
