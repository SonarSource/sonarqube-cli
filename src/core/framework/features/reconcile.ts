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

import * as fs from 'node:fs';

import logger from '@/core/observability/logger.ts';
import type {
  CliState,
  InstalledIntegration,
  InstalledIntegrationFeature,
  IntegrationStateAttribute,
} from '@/core/state/state.ts';
import { TerminalConsole } from '@/core/ui/terminal-console.ts';

import { findInstalledIntegration } from './installation-recorder.ts';
import { integrationInstaller } from './installer.ts';
import type { IntegrationRegistry } from './registry.ts';
import type { FeatureApplication, FeatureDeclaration, IntegrationDeclaration } from './types.ts';
import { isFeatureContainer } from './types.ts';

/**
 * Replays every registered integration's declared features against what is
 * currently recorded in state, re-applying anything stale (executionMode:
 * 'update'). Used by the CLI's post-update flow to keep installed
 * integrations in sync after an upgrade. Mutates `state` in place; the
 * caller is responsible for persisting it (returns whether it changed).
 */
export async function reconcileInstalledIntegrations(
  state: CliState,
  registry: IntegrationRegistry,
): Promise<boolean> {
  let stateChanged = false;

  for (const integration of registry.list()) {
    if (await reconcileIntegration(state, integration)) {
      stateChanged = true;
    }
  }

  return stateChanged;
}

async function reconcileIntegration(
  state: CliState,
  integration: IntegrationDeclaration,
): Promise<boolean> {
  const installedIntegration = findInstalledIntegration(state, integration);
  if (!installedIntegration) {
    return false;
  }

  const originalFeatures = [...installedIntegration.features];
  const { applications, removedUnknownFeatures } = buildReconcileApplications(
    integration,
    installedIntegration,
  );
  let stateChanged = removedUnknownFeatures;

  try {
    const installedFeatures = await integrationInstaller.applyAndRecordFeatures(
      state,
      integration,
      applications,
      {
        continueOnFeatureError: true,
        executionMode: 'update',
        console: new TerminalConsole(),
        onFeatureError: (application, err) => {
          logger.debug(
            `Declarative reconciliation failed for ${integration.id}.${application.feature.id}: ${err.message}`,
          );
        },
      },
    );
    if (installedFeatures.length > 0) {
      stateChanged = true;
    }
  } catch (err) {
    logger.debug(
      `Declarative reconciliation failed for ${integration.id}: ${(err as Error).message}`,
    );
  }
  restoreFailedReplacements(installedIntegration, originalFeatures, applications);

  return stateChanged;
}

function buildReconcileApplications(
  integration: IntegrationDeclaration,
  installedIntegration: InstalledIntegration,
): { applications: FeatureApplication[]; removedUnknownFeatures: boolean } {
  const featuresById = new Map(integration.features.map((feature) => [feature.id, feature]));
  const replacementApplications = migrateReplacedFeatures(
    integration,
    featuresById,
    installedIntegration.features,
  );
  const knownFeatures = installedIntegration.features.filter((feature) =>
    featuresById.has(feature.featureId),
  );
  const removedUnknownFeatures = knownFeatures.length !== installedIntegration.features.length;
  if (removedUnknownFeatures) {
    installedIntegration.features = knownFeatures;
  }

  const applications: FeatureApplication[] = [];
  for (const installedFeature of knownFeatures) {
    const application = createFeatureApplication(
      featuresById,
      installedFeature.featureId,
      installedFeature.subfeatures?.map((subfeature) => subfeature.featureId),
      installedFeature.targetRoot,
      installedFeature.scope,
      installedFeature.attrs,
    );
    if (application) {
      applications.push(application);
    }
  }
  applications.push(...replacementApplications);

  return { applications, removedUnknownFeatures };
}

/**
 * Migrates recorded predecessor installs into a declared successor feature
 * (`FeatureDeclaration.replacedIds`), merging their attrs and re-applying the
 * successor once per distinct (scope, targetRoot) the predecessors were
 * installed at.
 */
function migrateReplacedFeatures(
  integration: IntegrationDeclaration,
  featuresById: Map<string, FeatureDeclaration>,
  installedFeatures: InstalledIntegrationFeature[],
): FeatureApplication[] {
  const applications: FeatureApplication[] = [];

  for (const successor of integration.features) {
    const predecessorsByTarget = groupReplacedFeaturesByTarget(successor, installedFeatures);

    for (const predecessors of predecessorsByTarget.values()) {
      const { scope, targetRoot } = predecessors[0];
      const hasRecordedSuccessor = installedFeatures.some(
        (feature) =>
          feature.featureId === successor.id &&
          feature.scope === scope &&
          feature.targetRoot === targetRoot,
      );
      if (hasRecordedSuccessor) {
        continue;
      }
      const application = createFeatureApplication(
        featuresById,
        successor.id,
        undefined,
        targetRoot,
        scope,
        mergeFeatureAttrs(predecessors),
      );
      if (application) {
        applications.push(application);
      }
    }
  }

  return applications;
}

/**
 * A state-only rollback may retain predecessor feature ids that no longer exist
 * in the current declarations. Post-update will retry the migration on the next
 * version update; a future command (for example, `sonar doctor`) should also
 * allow users to trigger these migrations without waiting for another release.
 */
function restoreFailedReplacements(
  installedIntegration: InstalledIntegration,
  originalFeatures: InstalledIntegrationFeature[],
  applications: FeatureApplication[],
): void {
  for (const application of applications) {
    const replacedIds = application.feature.replacedIds;
    if (!replacedIds?.length) {
      continue;
    }
    const successorWasInstalled = installedIntegration.features.some(
      (feature) =>
        feature.featureId === application.feature.id &&
        feature.scope === application.scope &&
        feature.targetRoot === application.targetRoot,
    );
    if (successorWasInstalled) {
      continue;
    }

    const predecessorsToRestore = originalFeatures.filter(
      (originalFeature) =>
        replacedIds.includes(originalFeature.featureId) &&
        originalFeature.scope === application.scope &&
        originalFeature.targetRoot === application.targetRoot &&
        !installedIntegration.features.includes(originalFeature),
    );
    installedIntegration.features.push(...predecessorsToRestore);
  }
}

function groupReplacedFeaturesByTarget(
  successor: FeatureDeclaration,
  installedFeatures: InstalledIntegrationFeature[],
): Map<string, InstalledIntegrationFeature[]> {
  const predecessorsByTarget = new Map<string, InstalledIntegrationFeature[]>();

  for (const replacedId of successor.replacedIds ?? []) {
    for (const installedFeature of installedFeatures) {
      if (installedFeature.featureId !== replacedId) {
        continue;
      }
      const targetKey = `${installedFeature.scope}:${installedFeature.targetRoot}`;
      const predecessors = predecessorsByTarget.get(targetKey);
      if (predecessors) {
        predecessors.push(installedFeature);
      } else {
        predecessorsByTarget.set(targetKey, [installedFeature]);
      }
    }
  }
  return predecessorsByTarget;
}

function mergeFeatureAttrs(
  features: InstalledIntegrationFeature[],
): Record<string, IntegrationStateAttribute> | undefined {
  const attrs = features.reduce<Record<string, IntegrationStateAttribute>>(
    (merged, feature) => ({ ...merged, ...feature.attrs }),
    {},
  );
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function getFeature(
  featuresById: Map<string, FeatureDeclaration>,
  featureId: string,
  subfeatureIds: string[] | undefined,
  attrs: InstalledIntegrationFeature['attrs'],
): FeatureDeclaration | undefined {
  const feature = featuresById.get(featureId);
  if (!feature) {
    return undefined;
  }

  let applicationFeature = feature;
  if (isFeatureContainer(feature)) {
    const defaultIds =
      subfeatureIds ??
      feature.defaultInstallSubfeatureIds.filter((id) => {
        const subfeature = feature.subfeatures.find((s) => s.id === id);
        return subfeature?.migrationEligible?.(attrs) ?? true;
      });
    const activeIds = new Set(defaultIds);
    const filteredContainer = {
      ...feature,
      subfeatures: feature.subfeatures.filter((s) => activeIds.has(s.id)),
    };
    applicationFeature = filteredContainer;
  }
  return applicationFeature;
}

function createFeatureApplication(
  featuresById: Map<string, FeatureDeclaration>,
  featureId: string,
  subfeatureIds: string[] | undefined,
  targetRoot: string,
  scope: InstalledIntegrationFeature['scope'],
  attrs: InstalledIntegrationFeature['attrs'],
): FeatureApplication | undefined {
  const feature = getFeature(featuresById, featureId, subfeatureIds, attrs);
  if (!feature) {
    return undefined;
  }

  if (scope === 'project' && !fs.existsSync(targetRoot)) {
    logger.debug(
      `Declarative reconciliation skipped for ${featureId}: target root no longer exists: ${targetRoot}`,
    );
    return undefined;
  }

  return { feature, targetRoot, scope, attrs };
}
