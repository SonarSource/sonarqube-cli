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

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { SCA_SCANNER_CACHE_DIR } from '../../../../lib/config-constants';
import logger, { getLogLevelConfig } from '../../../../lib/logger';
import { type SonarQubeClient } from '../../../../sonarqube/client';
import type { ScaScannerInstaller } from '../../_common/install/sca-scanner';
import { assertScaAvailable } from '../../_common/sca-availability';
import { parseAnalysisProperties } from './analysis-properties';
import {
  type AnalyzeProjectResponse,
  type ScaScannerInvocation,
  ScaScannerRunner,
} from './sca-scanner';
import type { ScaScannerSpawner } from './sca-scanner-spawner';
import { buildScaUrls } from './sca-urls';

export class ScaScanOrchestrator {
  constructor(
    private readonly client: SonarQubeClient,
    private readonly installer: ScaScannerInstaller,
    private readonly spawner: ScaScannerSpawner,
  ) {}

  async run(auth: ResolvedAuth, projectKey: string): Promise<AnalyzeProjectResponse> {
    await assertScaAvailable(this.client, auth);
    const settings = await this.client.getProjectSettings(projectKey);
    const properties = parseAnalysisProperties(settings);
    logger.debug(`Resolved analysis properties: ${JSON.stringify(properties)}`);
    const { apiBaseUrl, downloadBaseUrl } = buildScaUrls(auth);
    const invocation: ScaScannerInvocation = {
      baseDir: process.cwd(),
      apiBaseUrl,
      downloadBaseUrl,
      sonarToken: auth.token,
      projectKey,
      cacheDir: SCA_SCANNER_CACHE_DIR,
      workDir: join(tmpdir(), `sonar-sca-${Date.now()}`),
      scannerProperties: properties.scaProperties,
      excludedPaths: properties.exclusions,
      includeGitIgnoredPaths: properties.includeGitIgnoredPaths,
      debug: getLogLevelConfig() === 'DEBUG',
    };
    return new ScaScannerRunner(this.installer, this.spawner).run(invocation);
  }
}
