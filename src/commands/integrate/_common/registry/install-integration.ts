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

import { text, warn } from '../../../../core/ui';
import type { ResolvedAuth } from '../../../../lib/auth-resolver.ts';
import logger from '../../../../lib/logger.ts';
import { findGitRoot } from '../../../../lib/project-workspace/project-info.ts';
import { loadState, saveState } from '../../../../lib/repository/state-repository.ts';
import type {
  CliState,
  InstalledIntegrationFeature,
  IntegrationScope,
  IntegrationStateAttribute,
} from '../../../../lib/state.ts';
import { emitIntegrationConfiguredTelemetry } from '../../../../telemetry/integrate-telemetry.ts';
import { CommandFailedError } from '../../../_common/error.ts';
import { renderCompletionSummary } from './completion-summary.ts';
import type { IntegrationRegistry } from './core.ts';
import { buildApplications } from './feature-target.ts';
import { renderInstallPreviewAndConfirm } from './install-preview.ts';
import { integrationInstaller } from './installer.ts';
import { isFeatureContainer, selectFeaturesForInvocation } from './selection.ts';
import type {
  IntegrationContext,
  IntegrationDeclaration,
  IntegrationExecutionMode,
  IntegrationInvocation,
} from './types.ts';

export interface InstallIntegrationOptions<TOptions> {
  registry: IntegrationRegistry;
  integrationId: string;
  options: TOptions;
  targetRoot: string;
  scope: IntegrationScope;
  auth?: ResolvedAuth;
  force?: boolean;
  attrs?: Record<string, IntegrationStateAttribute>;
  nonInteractive?: boolean;
  /** True when invoked via the bare `sonar integrate` router (telemetry only). */
  isFromRouter?: boolean;
}

export async function installIntegration<TOptions>({
  registry,
  integrationId,
  options,
  targetRoot,
  scope,
  auth,
  force,
  attrs,
  nonInteractive,
  isFromRouter,
}: InstallIntegrationOptions<TOptions>): Promise<InstalledIntegrationFeature[]> {
  const integration = getIntegrationDeclaration<TOptions>(registry, integrationId);
  const state = loadState();
  const invocation: IntegrationInvocation<TOptions> = {
    options,
    targetRoot,
    scope,
    auth,
    force,
    attrs,
    nonInteractive,
    state,
  };
  const applications = await buildApplications(invocation, integration.features);
  const { toInstall, toRemove, declined } = await selectFeaturesForInvocation(
    integration,
    invocation,
    applications,
  );
  if (toInstall.length === 0 && toRemove.length === 0) {
    throw new CommandFailedError(`No feature selected for ${integration.displayName}`);
  }

  text('');
  await renderInstallPreviewAndConfirm(toInstall, nonInteractive);
  text('');

  try {
    const installedFeatures = await integrationInstaller.applyAndRecordFeatures(
      state,
      integration,
      toInstall,
      {
        callbacks: {
          onFeatureApplyStart: (feature) => {
            text(`     Installing ${feature.displayName}...`);
            if (isFeatureContainer(feature)) {
              for (const subfeature of feature.subfeatures) {
                text(`       - ${subfeature.displayName}`);
              }
            }
          },
          onDependencySkipped: (dependency) => {
            text(`     ${dependency.displayName ?? dependency.id} already installed`);
          },
          onResourceSkipped: (resource) => {
            text(`     ${resource.displayName ?? resource.id} already installed`);
          },
        },
        executionMode: 'install',
      },
    );

    const removedFeatures = await integrationInstaller.removeAndRecordFeatures(
      state,
      integration,
      toRemove,
      {
        callbacks: {
          onFeatureRemoveStart: (feature) => {
            text(`     Removing ${feature.displayName}...`);
          },
          onDependencyRemoved: (dependency) => {
            text(`     ${dependency.displayName ?? dependency.id} removed`);
          },
        },
      },
    );

    renderCompletionSummary(integration, installedFeatures, removedFeatures);

    const stateSaved = saveInstalledFeatures(state);
    if (stateSaved) {
      await emitIntegrationConfiguredTelemetry({
        // `integrate` is an authenticatedAction, so auth is always present here.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        auth: auth!,
        integrationId,
        scope,
        nonInteractive: nonInteractive ?? false,
        isFromRouter: isFromRouter ?? false,
        installedFeatures,
        featuresDeclined: declined,
        featuresUninstalled: toRemove.map((application) => application.feature.id),
        repoRoot: resolveRepoRootForScope(scope, targetRoot),
      });
    }

    return stateSaved ? installedFeatures : [];
  } catch (error) {
    saveInstalledFeatures(state);
    throw error;
  }
}

export function makeContext(
  state: CliState,
  targetRoot: string,
  scope: IntegrationScope,
  executionMode: IntegrationExecutionMode,
  auth: ResolvedAuth | undefined,
  force: boolean | undefined,
  attrs: Record<string, IntegrationStateAttribute> | undefined,
): IntegrationContext {
  return {
    state,
    targetRoot,
    scope,
    executionMode,
    auth,
    force,
    attrs,
    resolvedDependencies: new Map(),
  };
}

/**
 * Repo root for telemetry `repo_id`: the git root for
 * project-scope installs, or null for global scope / non-git targets.
 */
function resolveRepoRootForScope(scope: IntegrationScope, targetRoot: string): string | null {
  if (scope === 'global') return null;
  const { gitRoot, isGit } = findGitRoot(targetRoot);
  return isGit ? gitRoot : null;
}

function saveInstalledFeatures(state: CliState): boolean {
  try {
    try {
      state.tools = loadState().tools;
    } catch (err) {
      logger.debug(`Failed to merge latest tools state before save: ${(err as Error).message}`);
    }
    saveState(state);
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    warn(`Failed to update configuration state: ${msg}`);
    logger.warn(`Failed to update configuration state: ${msg}`);
    return false;
  }
}

function getIntegrationDeclaration<TOptions>(
  registry: IntegrationRegistry,
  integrationId: string,
): IntegrationDeclaration<TOptions> {
  const integration = registry.get(integrationId);
  if (!integration) {
    throw new CommandFailedError(`Integration declaration is not registered: ${integrationId}`);
  }
  return integration as IntegrationDeclaration<TOptions>;
}
