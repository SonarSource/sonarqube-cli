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
import { discreetSuccess, info, text, warn } from '../../../../../ui';
import { CommandFailedError } from '../../../_common/error';
import { supportedIntegrations } from '../../index';
import { renderCompletionSummary } from './completion-summary';
import type { IntegrationRegistry } from './core';
import type { FeatureApplication } from './installer';
import { integrationInstaller } from './installer';
import type {
  FeatureDeclaration,
  IntegrationContext,
  IntegrationDeclaration,
  IntegrationExecutionMode,
  IntegrationInvocation,
} from './types';

export interface InstallIntegrationOptions<TOptions> {
  registry?: IntegrationRegistry;
  integrationId: string;
  options: TOptions;
  targetRoot: string;
  scope: IntegrationScope;
  auth?: ResolvedAuth;
  force?: boolean;
  attrs?: Record<string, IntegrationStateAttribute>;
  featureIds?: string[];
}

export async function installIntegration<TOptions>({
  registry = supportedIntegrations,
  integrationId,
  options,
  targetRoot,
  scope,
  auth,
  force,
  attrs,
  featureIds,
}: InstallIntegrationOptions<TOptions>): Promise<InstalledIntegrationFeature[]> {
  const integration = getIntegrationDeclaration<TOptions>(registry, integrationId);
  const invocation = makeInvocation(options, targetRoot, scope, auth, force, attrs);
  const features =
    featureIds === undefined
      ? await integrationInstaller.selectFeaturesForInvocation(integration, invocation)
      : integrationInstaller.selectFeatures(integration, featureIds);
  if (features.length === 0) {
    throw new CommandFailedError(`No feature selected for ${integration.displayName}`);
  }

  const state = loadStateForInstallation();
  const applications: FeatureApplication<TOptions>[] = [];
  for (const feature of features) {
    const context = await resolveFeatureContext(state, invocation, feature, 'install');
    applications.push({
      feature,
      targetRoot: context.targetRoot,
      scope: context.scope,
      auth: context.auth,
      force: context.force,
      attrs: context.attrs,
    });
    text(`Installing ${integration.displayName}: ${feature.displayName}`);
  }

  try {
    const installedFeatures = await integrationInstaller.applyAndRecordFeatures(
      state,
      integration,
      applications,
      {
        callbacks: {
          onDependencyInstalled: (dependency) => {
            discreetSuccess(`Installed ${dependency.displayName ?? dependency.id}`);
          },
          onDependencySkipped: (dependency) => {
            info(`${dependency.displayName ?? dependency.id} already installed`);
          },
          onResourceInstalled: (resource) => {
            discreetSuccess(`Installed ${resource.displayName ?? resource.id}`);
          },
          onResourceSkipped: (resource) => {
            info(`${resource.displayName ?? resource.id} already installed`);
          },
          onOperationApplied: (operation) => {
            discreetSuccess(`Applied ${operation.displayName ?? operation.id}`);
          },
        },
        executionMode: 'install',
      },
    );

    renderCompletionSummary(integration, installedFeatures);

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

function makeInvocation<TOptions>(
  options: TOptions,
  targetRoot: string,
  scope: IntegrationScope,
  auth: ResolvedAuth | undefined,
  force: boolean | undefined,
  attrs: Record<string, IntegrationStateAttribute> | undefined,
): IntegrationInvocation<TOptions> {
  return { options, targetRoot, scope, auth, force, attrs };
}

async function resolveFeatureContext<TOptions>(
  state: CliState,
  invocation: IntegrationInvocation<TOptions>,
  feature: FeatureDeclaration<TOptions>,
  executionMode: IntegrationExecutionMode,
): Promise<IntegrationContext> {
  return makeContext(
    state,
    await resolveFeatureTargetRoot(invocation, feature),
    await resolveFeatureScope(invocation, feature),
    executionMode,
    invocation.auth,
    invocation.force,
    invocation.attrs,
  );
}

async function resolveFeatureTargetRoot<TOptions>(
  invocation: IntegrationInvocation<TOptions>,
  feature: FeatureDeclaration<TOptions>,
): Promise<string> {
  const { targetRoot } = feature;
  if (typeof targetRoot === 'function') {
    return targetRoot(invocation);
  }
  return targetRoot ?? invocation.targetRoot;
}

async function resolveFeatureScope<TOptions>(
  invocation: IntegrationInvocation<TOptions>,
  feature: FeatureDeclaration<TOptions>,
): Promise<IntegrationScope> {
  const { scope } = feature;
  if (typeof scope === 'function') {
    return scope(invocation);
  }
  return scope ?? invocation.scope;
}
