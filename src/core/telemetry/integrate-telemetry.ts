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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';

import { canonicalizePath } from '../io/fs-utils.ts';
import logger from '../observability/logger.ts';
import type { InstalledIntegrationFeature, IntegrationScope } from '../state/state.ts';
import { emitIntegrationConfigured } from './telemetry-events.ts';

export interface IntegrationConfiguredTelemetryParams {
  auth: ResolvedAuth;
  integrationId: string;
  scope: IntegrationScope;
  nonInteractive: boolean;
  isFromRouter: boolean;
  /** Features actually installed by this run (including active subfeatures). */
  installedFeatures: InstalledIntegrationFeature[];
  /** Feature ids the user declined (offered via `ask`, never installed). */
  featuresDeclined: string[];
  /** Previously-installed feature ids the user removed this run. */
  featuresUninstalled: string[];
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
      features_declined: params.featuresDeclined,
      features_uninstalled: params.featuresUninstalled,
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
