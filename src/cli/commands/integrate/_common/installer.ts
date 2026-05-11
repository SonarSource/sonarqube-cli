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

import { version as VERSION } from '../../../../../package.json';
import logger from '../../../../lib/logger';
import { loadState, saveState } from '../../../../lib/repository/state-repository';
import {
  type CliState,
  getDefaultState,
  type InstalledIntegrationFeature,
  type IntegrationScope,
  type IntegrationStateAttribute,
} from '../../../../lib/state';
import { info, success, text, warn } from '../../../../ui';
import { CommandFailedError } from '../../_common/error';
import {
  type AppliedFeature,
  type FeatureDeclaration,
  type IntegrationContext,
  type IntegrationDeclaration,
  integrationInstaller,
  supportedIntegrations,
} from './registry';

export interface InstallIntegrationOptions<TOptions> {
  integrationId: string;
  options: TOptions;
  targetRoot: string;
  scope: IntegrationScope;
  force?: boolean;
  attrs?: Record<string, IntegrationStateAttribute>;
}

export async function installIntegration<TOptions>({
  integrationId,
  options,
  targetRoot,
  scope,
  force,
  attrs,
}: InstallIntegrationOptions<TOptions>): Promise<InstalledIntegrationFeature[]> {
  const integration = getIntegrationDeclaration<TOptions>(integrationId);
  const features = integrationInstaller.selectFeaturesForInvocation(integration, { options });
  if (features.length === 0) {
    throw new CommandFailedError(`No feature selected for ${integration.displayName}`);
  }

  const installedFeatures: InstalledIntegrationFeature[] = [];
  for (const feature of features) {
    const context = makeContext(loadStateForInstallation(), targetRoot, scope, force, attrs);
    const installedFeature = integrationInstaller.findInstalledFeature(
      context.state,
      context,
      integration,
      feature,
    );
    text(`Installing ${integration.displayName}: ${feature.displayName}`);
    const applied = await applyFeature(context, installedFeature, feature);
    const installed = recordFeatureInstallation(integration, feature, {
      targetRoot,
      scope,
      force,
      attrs,
      applied,
    });
    if (installed) {
      installedFeatures.push(installed);
    }
  }

  return installedFeatures;
}

function getIntegrationDeclaration<TOptions>(
  integrationId: string,
): IntegrationDeclaration<TOptions> {
  const integration = supportedIntegrations.get(integrationId);
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

function makeContext(
  state: CliState,
  targetRoot: string,
  scope: IntegrationScope,
  force: boolean | undefined,
  attrs: Record<string, IntegrationStateAttribute> | undefined,
): IntegrationContext {
  return {
    state,
    targetRoot,
    scope,
    force,
    attrs,
  };
}

async function applyFeature<TOptions>(
  context: IntegrationContext,
  installedFeature: InstalledIntegrationFeature | undefined,
  feature: FeatureDeclaration<TOptions>,
): Promise<AppliedFeature> {
  const resources: AppliedFeature['resources'] = [];
  const operations: AppliedFeature['operations'] = [];

  for (const resource of feature.resources ?? []) {
    const label = resource.displayName ?? resource.id;
    if (!(await integrationInstaller.resourceNeedsApply(context, installedFeature, resource))) {
      info(`${label} already installed`);
      continue;
    }
    resources.push(await resource.apply(context));
    success(`Installed ${label}`);
  }

  for (const operation of feature.operations ?? []) {
    const label = operation.displayName ?? operation.id;
    if (operation.shouldApply && !(await operation.shouldApply(context))) {
      continue;
    }
    await operation.apply(context);
    operations.push({ id: operation.id, version: operation.version });
    success(`Applied ${label}`);
  }

  return { resources, operations };
}

function recordFeatureInstallation<TOptions>(
  integration: IntegrationDeclaration<TOptions>,
  feature: FeatureDeclaration<TOptions>,
  {
    targetRoot,
    scope,
    force,
    attrs,
    applied,
  }: {
    targetRoot: string;
    scope: IntegrationScope;
    force?: boolean;
    attrs?: Record<string, IntegrationStateAttribute>;
    applied: AppliedFeature;
  },
): InstalledIntegrationFeature | undefined {
  try {
    const state = loadState();
    const context = makeContext(state, targetRoot, scope, force, attrs);
    const installed = integrationInstaller.recordInstalledFeature(
      state,
      context,
      integration,
      feature,
      applied,
    );
    saveState(state);
    return installed;
  } catch (err) {
    const msg = (err as Error).message;
    warn(`Failed to update configuration state: ${msg}`);
    logger.warn(`Failed to update configuration state: ${msg}`);
    return undefined;
  }
}
