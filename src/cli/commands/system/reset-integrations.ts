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

import type {
  CliState,
  InstalledIntegration,
  InstalledIntegrationFeature,
} from '../../../lib/state';
import type { PhaseItem } from '../../../ui';
import { phaseItem } from '../../../ui';
import {
  type IntegrationDeclaration,
  integrationInstaller,
  type IntegrationRegistry,
  makeContext,
} from '../integrate/_common/registry';

export interface IntegrationResetResult {
  item: PhaseItem;
  integrationFeatures: Array<{ integrationStateId: string; featureId: string }>;
}

type FeatureRemoveOutcome =
  | { status: 'removed'; integrationStateId: string; featureId: string }
  | { status: 'failed'; message: string };

interface DeclarativeIntegrationReset {
  integrationFeatures: Array<{ integrationStateId: string; featureId: string }>;
  failed: string[];
  removedFeatures: number;
}

export async function removeAllIntegrations(state: CliState): Promise<IntegrationResetResult> {
  const supportedIntegrations = await loadSupportedIntegrations();
  const declarative = await removeDeclarativeIntegrations(state, supportedIntegrations);

  return {
    item: buildIntegrationPhaseItem(declarative.removedFeatures, declarative.failed),
    integrationFeatures: declarative.integrationFeatures,
  };
}

async function loadSupportedIntegrations(): Promise<IntegrationRegistry> {
  const { supportedIntegrations } = await import('../integrate/index.js');
  return supportedIntegrations;
}

async function removeDeclarativeIntegrations(
  state: CliState,
  supportedIntegrations: IntegrationRegistry,
): Promise<DeclarativeIntegrationReset> {
  const integrationFeatures: Array<{ integrationStateId: string; featureId: string }> = [];
  const failed: string[] = [];
  let removedFeatures = 0;

  for (const installed of state.integrations.installed) {
    const declaration = supportedIntegrations.get(installed.integrationId);
    if (!declaration) {
      failed.push(`${installed.integrationId}: unknown integration`);
      continue;
    }

    for (const installedFeature of installed.features) {
      const outcome = await tryRemoveInstalledFeature(
        state,
        installed,
        installedFeature,
        declaration,
      );
      if (outcome.status === 'removed') {
        integrationFeatures.push({
          integrationStateId: outcome.integrationStateId,
          featureId: outcome.featureId,
        });
        removedFeatures += 1;
      } else {
        failed.push(outcome.message);
      }
    }
  }

  return { integrationFeatures, failed, removedFeatures };
}

async function tryRemoveInstalledFeature(
  state: CliState,
  installed: InstalledIntegration,
  installedFeature: InstalledIntegrationFeature,
  declaration: IntegrationDeclaration,
): Promise<FeatureRemoveOutcome> {
  const featureDeclaration = declaration.features.find(
    (feature) => feature.id === installedFeature.featureId,
  );
  if (!featureDeclaration) {
    return {
      status: 'failed',
      message: `${installed.integrationId}.${installedFeature.featureId}: unknown feature`,
    };
  }

  // There is no dedicated "remove" execution mode: removeFeature only invokes
  // resource.remove / operation.undo, none of which branch on executionMode.
  // 'install' is passed to satisfy makeContext; revisit if any undo path ever
  // needs to distinguish a reset from an install.
  const context = makeContext(
    state,
    installedFeature.targetRoot,
    installedFeature.scope,
    'install',
    undefined,
    true,
    installedFeature.attrs,
  );

  try {
    await integrationInstaller.removeFeature(context, featureDeclaration);
    return {
      status: 'removed',
      integrationStateId: installed.id,
      featureId: installedFeature.featureId,
    };
  } catch (err) {
    return {
      status: 'failed',
      message: `${installed.integrationId}.${installedFeature.featureId}: ${(err as Error).message}`,
    };
  }
}

function buildIntegrationPhaseItem(totalRemoved: number, failed: string[]): PhaseItem {
  if (failed.length > 0) {
    const counts =
      totalRemoved > 0
        ? `${totalRemoved} removed, ${failed.length} failed`
        : `${failed.length} failed`;
    return phaseItem('Integrations', 'warn', `${counts}: ${failed.join('; ')}`);
  }

  if (totalRemoved > 0) {
    const label = totalRemoved === 1 ? 'target' : 'targets';
    return phaseItem('Integrations', 'done', `Removed ${totalRemoved} integration ${label}.`);
  }

  return phaseItem('Integrations', 'info', 'Nothing to remove.');
}
