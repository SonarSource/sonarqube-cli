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

import { createHash } from 'node:crypto';

import type { ResolvedAuth } from '../lib/auth-resolver.js';
import { canonicalizePath } from '../lib/fs-utils.js';
import logger from '../lib/logger.js';
import type { InstalledIntegrationFeature, IntegrationScope } from '../lib/state.js';
import { emitIntegrationConfigured } from './findings.js';

export interface IntegrationConfiguredTelemetryParams {
  auth: ResolvedAuth;
  integrationId: string;
  scope: IntegrationScope;
  nonInteractive: boolean;
  isFromRouter: boolean;
  /** Features actually installed by this run (including active subfeatures). */
  installedFeatures: InstalledIntegrationFeature[];
  /**
   * Feature ids the user deliberately skipped: those offered (`ask`) and declined,
   * plus already-installed features the user chose to uninstall this run.
   */
  featuresSkipped: string[];
  /** Repo root path when known (project scope, inside a git repo); null otherwise. */
  repoRoot: string | null;
}

/**
 * Assembles and emits a single CliIntegrationConfigured
 * event for a successful `sonar integrate` run.
 */
export async function emitIntegrationConfiguredTelemetry(
  params: IntegrationConfiguredTelemetryParams,
): Promise<void> {
  try {
    const featuresInstalled = collectInstalledFeatureIds(params.installedFeatures);

    await emitIntegrationConfigured(params.auth, {
      integration_id: params.integrationId,
      repo_id: hashRepoRoot(params.repoRoot),
      features_installed: featuresInstalled,
      features_skipped: params.featuresSkipped,
      is_global: params.scope === 'global',
      is_interactive: !params.nonInteractive,
      is_from_router: params.isFromRouter,
    });
  } catch (err) {
    logger.debug(`Failed to emit CliIntegrationConfigured telemetry: ${(err as Error).message}`);
  }
}

/** Flattens installed features to their ids plus active subfeature ids. */
function collectInstalledFeatureIds(installedFeatures: InstalledIntegrationFeature[]): string[] {
  const ids: string[] = [];
  for (const feature of installedFeatures) {
    ids.push(feature.featureId);
    for (const subfeature of feature.subfeatures ?? []) {
      ids.push(subfeature.featureId);
    }
  }
  return ids;
}

/** SHA-256 hex of the repo root path. */
function hashRepoRoot(repoRoot: string | null): string | null {
  if (!repoRoot) return null;
  return createHash('sha256').update(canonicalizePath(repoRoot)).digest('hex');
}
