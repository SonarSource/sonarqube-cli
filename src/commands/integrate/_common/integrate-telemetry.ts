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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import {
  type CommandInvocationContext,
  TelemetryFact,
} from '@/core/commands/invocation-context.ts';
import type { InstalledIntegrationFeature, IntegrationScope } from '@/core/state/state.ts';
import { hashRepoRoot } from '@/core/telemetry/repo-id.ts';

import type { SetupSource } from './types.ts';

export const CLI_INTEGRATION_CONFIGURED = 'CliIntegrationConfigured';

/** Domain payload for CliIntegrationConfigured (identity is filled at drain time). */
export type IntegrationConfiguredPayload = {
  integration_id: string;
  repo_id: string | null;
  features_installed: string[];
  features_declined: string[];
  features_uninstalled: string[];
  is_global: boolean;
  is_interactive: boolean;
  is_from_router: boolean;
  setup_source?: SetupSource;
};

export interface IntegrationConfiguredTelemetryParams {
  auth: ResolvedAuth;
  integrationId: string;
  scope: IntegrationScope;
  nonInteractive: boolean;
  isFromRouter: boolean;
  setupSource?: SetupSource;
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
 * Record a CliIntegrationConfigured fact for postAction drain.
 */
export function recordIntegrationConfigured(
  ctx: CommandInvocationContext,
  params: IntegrationConfiguredTelemetryParams,
): void {
  ctx.recordTelemetry(
    new TelemetryFact<IntegrationConfiguredPayload>(
      CLI_INTEGRATION_CONFIGURED,
      {
        integration_id: params.integrationId,
        repo_id: hashRepoRoot(params.repoRoot),
        features_installed: collectInstalledFeatureIds(params.installedFeatures),
        features_declined: params.featuresDeclined,
        features_uninstalled: params.featuresUninstalled,
        is_global: params.scope === 'global',
        is_interactive: !params.nonInteractive,
        is_from_router: params.isFromRouter,
        ...(params.setupSource ? { setup_source: params.setupSource } : {}),
      },
      { auth: params.auth },
    ),
  );
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
