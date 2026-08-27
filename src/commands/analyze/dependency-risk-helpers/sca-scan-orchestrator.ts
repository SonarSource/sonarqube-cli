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

import {
  emitScaAnalysisTelemetry,
  type ScaCallerCommand,
} from '@/commands/analyze/sca-analysis-telemetry.ts';
import type { CommandInvocationContext } from '@/commands/command-invocation-context.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { SCA_SCANNER_CACHE_DIR } from '@/core/config-constants.ts';
import type { ScaScannerInstaller } from '@/core/host/install/sca-scanner.ts';
import type { SecretsInstaller } from '@/core/host/install/secrets.ts';
import logger, { getLogLevelConfig } from '@/core/observability/logger.ts';
import { type SonarQubeClient } from '@/core/server/client.ts';
import { assertScaAvailable } from '@/core/server/sca-availability.ts';
import type { SettingsValue } from '@/core/server/settings-value.ts';
import { withSpinner } from '@/core/ui';

import { parseAnalysisProperties } from './analysis-properties.ts';
import { preScanManifestsForSecrets } from './manifest-secrets-guard.ts';
import { type AnalyzeProjectResponse, ScaScannerRunner } from './sca-scanner.ts';
import type { ScaScannerInvocation } from './sca-scanner-runner-base.ts';
import type { ScaScannerSpawner } from './sca-scanner-spawner.ts';
import { buildScaUrls } from './sca-urls.ts';

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

  async run(
    auth: ResolvedAuth,
    projectKey: string,
    callerCommand: ScaCallerCommand,
    ctx: CommandInvocationContext,
  ): Promise<ScaScanResult> {
    // Only the SCA scan itself is telemetered (below). Pre-flight failures — settings sync,
    // `assertScaAvailable`, and the secrets pre-scan — intentionally emit no SCA event: they
    // mean the scanner never ran (mirroring the secrets/SQAA producers, which likewise only
    // measure the analyzer run). Command-level failures remain visible via CliCommandExecuted.
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

    // A secret found here throws before the SCA scanner ever spawns; that throw propagates
    // WITHOUT emitting an SCA event (the secrets analyzer owns its own telemetry).
    await preScanManifestsForSecrets({
      invocation,
      baseDir,
      auth,
      scaInstaller: this.installer,
      scaSpawner: this.spawner,
      secretsInstaller: this.secretsInstaller,
      ctx,
    });

    // Time and telemeter only the SCA scan, so scan_duration_ms and a failures_count:1 event
    // reflect the sca-scanner alone — never the settings sync or the secrets pre-scan above.
    const scanStart = performance.now();
    try {
      const response = await this.analyzeDependencyRisks(invocation);
      return { response, scanDurationMs: Math.round(performance.now() - scanStart) };
    } catch (err) {
      await emitScaAnalysisTelemetry(
        callerCommand,
        auth,
        null,
        Math.round(performance.now() - scanStart),
        null,
      );
      throw err;
    }
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
