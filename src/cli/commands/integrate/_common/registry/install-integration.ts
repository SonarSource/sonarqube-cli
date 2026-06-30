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

import { version as VERSION } from '../../../../../../package.json';
import type { ResolvedAuth } from '../../../../../lib/auth-resolver';
import logger from '../../../../../lib/logger';
import { loadState, saveState } from '../../../../../lib/repository/state-repository';
import type {
  CliState,
  InstalledIntegrationFeature,
  IntegrationScope,
  IntegrationStateAttribute,
} from '../../../../../lib/state';
import { getDefaultState } from '../../../../../lib/state';
import { text, warn } from '../../../../../ui';
import { CommandFailedError } from '../../../_common/error';
import { renderCompletionSummary } from './completion-summary';
import type { IntegrationRegistry } from './core';
import { buildApplications } from './feature-target';
import { renderInstallPreviewAndConfirm } from './install-preview';
import { integrationInstaller } from './installer';
import { isFeatureContainer, selectFeaturesForInvocation } from './selection';
import type {
  IntegrationContext,
  IntegrationDeclaration,
  IntegrationExecutionMode,
  IntegrationInvocation,
} from './types';

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
}: InstallIntegrationOptions<TOptions>): Promise<InstalledIntegrationFeature[]> {
  const integration = getIntegrationDeclaration<TOptions>(registry, integrationId);
  const state = loadStateForInstallation();
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
  const { toInstall, toRemove } = await selectFeaturesForInvocation(
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

    return saveInstalledFeatures(state) ? installedFeatures : [];
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

function loadStateForInstallation(): CliState {
  try {
    return loadState();
  } catch (err) {
    const msg = (err as Error).message;
    warn(`Failed to read configuration state: ${msg}`);
    logger.warn(`Failed to read configuration state: ${msg}`);
    return getDefaultState(VERSION);
  }
}
