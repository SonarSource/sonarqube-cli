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
import { timed } from '../../../../lib/timed';
import { type SonarQubeClient } from '../../../../sonarqube/client';
import type { SettingsValue } from '../../../../sonarqube/settings-value';
import { withSpinner } from '../../../../ui';
import type { ScaScannerInstaller } from '../../_common/install/sca-scanner';
import type { SecretsInstaller } from '../../_common/install/secrets';
import { assertScaAvailable } from '../../_common/sca-availability';
import { parseAnalysisProperties } from './analysis-properties';
import { preScanManifestsForSecrets } from './manifest-secrets-guard';
import { type AnalyzeProjectResponse, ScaScannerRunner } from './sca-scanner';
import type { ScaScannerInvocation } from './sca-scanner-runner-base';
import type { ScaScannerSpawner } from './sca-scanner-spawner';
import { buildScaUrls } from './sca-urls';

/** SCA scan result plus the wall-clock duration of the scan itself (excludes settings sync and the secrets pre-scan), for `scan_duration_ms` telemetry. */
export interface ScaScanResult {
  response: AnalyzeProjectResponse;
  scanDurationMs: number;
}

export class ScaScanOrchestrator {
  constructor(
    private readonly client: SonarQubeClient,
    private readonly installer: ScaScannerInstaller,
    private readonly spawner: ScaScannerSpawner,
    private readonly secretsInstaller: SecretsInstaller,
  ) {}

  async run(auth: ResolvedAuth, projectKey: string): Promise<ScaScanResult> {
    const settings = await this.synchronizeSettings(auth, projectKey);
    const properties = parseAnalysisProperties(settings);
    logger.debug(`Resolved analysis properties: ${JSON.stringify(properties)}`);
    const { apiBaseUrl, downloadBaseUrl } = buildScaUrls(auth);
    const baseDir = process.cwd();
    const invocation: ScaScannerInvocation = {
      baseDir,
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

    await preScanManifestsForSecrets({
      invocation,
      baseDir,
      auth,
      scaInstaller: this.installer,
      scaSpawner: this.spawner,
      secretsInstaller: this.secretsInstaller,
    });

    const { result, durationMs } = await timed(() => this.analyzeDependencyRisks(invocation));
    return { response: result, scanDurationMs: durationMs };
  }

  private synchronizeSettings(auth: ResolvedAuth, projectKey: string): Promise<SettingsValue[]> {
    return withSpinner(
      'Synchronizing settings',
      async () => {
        await assertScaAvailable(this.client, auth);
        return this.client.getProjectSettings(projectKey);
      },
      'stderr',
    );
  }

  private analyzeDependencyRisks(
    invocation: ScaScannerInvocation,
  ): Promise<AnalyzeProjectResponse> {
    return new ScaScannerRunner(this.installer, this.spawner).run(invocation);
  }
}
