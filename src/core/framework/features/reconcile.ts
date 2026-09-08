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
import type { Console } from '@/core/ui/console.ts';

import { findInstalledIntegration } from './installation-recorder.ts';
import { integrationInstaller } from './installer.ts';
import type { IntegrationRegistry } from './registry.ts';
import type {
  FeatureApplication,
  FeatureContainer,
  FeatureDeclaration,
  IntegrationDeclaration,
} from './types.ts';
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
  console: Console,
): Promise<boolean> {
  let stateChanged = false;

  for (const integration of registry.list()) {
    if (await reconcileIntegration(state, integration, console)) {
      stateChanged = true;
    }
  }

  // Last step, once every entry above is current: collapse any project-scope installs of a
  // feature (or one of its `replacedIds`) that coexist with an already-installed global one for
  // the same integration into that single global record.
  for (const integration of registry.list()) {
    if (await collapseGlobalScopeCoexistence(state, integration, console)) {
      stateChanged = true;
    }
  }

  return stateChanged;
}

async function reconcileIntegration(
  state: CliState,
  integration: IntegrationDeclaration,
  console: Console,
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
        console,
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

/**
 * The subfeature ids a container falls back to when the caller has no recorded subfeature set to
 * carry forward (an old plain-feature install, predating containers) — `defaultInstallSubfeatureIds`
 * filtered by each subfeature's own `migrationEligible(attrs)`, since `shouldInstall`'s `options`
 * don't exist during reconciliation.
 */
function defaultEligibleSubfeatureIds<TOptions>(
  container: FeatureContainer<TOptions>,
  attrs: InstalledIntegrationFeature['attrs'],
): string[] {
  return container.defaultInstallSubfeatureIds.filter((id) => {
    const subfeature = container.subfeatures.find((s) => s.id === id);
    return subfeature?.migrationEligible?.(attrs) ?? true;
  });
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
    const defaultIds = subfeatureIds ?? defaultEligibleSubfeatureIds(feature, attrs);
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

/**
 * Collapses project-scope installs of a feature (or one of its `replacedIds`) that coexist with
 * an already-installed global one for the same integration into that single global record —
 * merging attrs and unioning active subfeatures — then tears down the stale project installs.
 * Several agents merge global and project config rather than one overriding the other, so leaving
 * both around keeps the old per-repo install firing side-by-side with the new global one.
 */
async function collapseGlobalScopeCoexistence(
  state: CliState,
  integration: IntegrationDeclaration,
  console: Console,
): Promise<boolean> {
  const installedIntegration = findInstalledIntegration(state, integration);
  if (!installedIntegration) {
    return false;
  }
  const featuresById = new Map(integration.features.map((feature) => [feature.id, feature]));

  let stateChanged = false;
  for (const successor of integration.features) {
    const collapsed = await collapseFeatureCoexistence(
      state,
      integration,
      installedIntegration,
      featuresById,
      successor,
      console,
    );
    if (collapsed) {
      stateChanged = true;
    }
  }
  return stateChanged;
}

/**
 * A literal `scope: 'project'` on a feature already means "never run this at global scope" —
 * Vortex's container already relies on exactly this to stay project-only. A dynamic `scope`
 * function is treated as eligible: it can't be resolved headlessly here, and none of today's
 * declarations use one.
 *
 * TODO: subfeatures don't carry their own `scope` (`SubfeatureDeclaration` has no such field), so
 * a subfeature that must stay project-only independent of its siblings — e.g. git's
 * `pre-commit-dependency-risks`, whose own `shouldInstall` already refuses `scope === 'global'` —
 * isn't blocked here if it's active on a coexisting project entry. Revisit if that becomes a live
 * scenario; today `shouldInstall` already prevents it from ever being *installed* at global scope
 * in the first place, so this only matters for that container being merged by this migration.
 */
function isGlobalScopeEligible(feature: FeatureDeclaration): boolean {
  return feature.scope !== 'project';
}

async function collapseFeatureCoexistence(
  state: CliState,
  integration: IntegrationDeclaration,
  installedIntegration: InstalledIntegration,
  featuresById: Map<string, FeatureDeclaration>,
  successor: FeatureDeclaration,
  console: Console,
): Promise<boolean> {
  if (!isGlobalScopeEligible(successor)) {
    return false;
  }

  const matchingIds = new Set([successor.id, ...(successor.replacedIds ?? [])]);
  const coexisting = installedIntegration.features.filter((feature) =>
    matchingIds.has(feature.featureId),
  );
  const globalEntry = coexisting.find((feature) => feature.scope === 'global');
  const projectEntries = coexisting.filter((feature) => feature.scope === 'project');
  if (!globalEntry || projectEntries.length === 0) {
    return false;
  }

  const subfeatureIds = isFeatureContainer(successor)
    ? unionActiveSubfeatureIds(successor, coexisting)
    : undefined;
  const application = createFeatureApplication(
    featuresById,
    successor.id,
    subfeatureIds,
    globalEntry.targetRoot,
    'global',
    mergeFeatureAttrs([...projectEntries, globalEntry]),
  );
  if (!application) {
    return false;
  }

  let succeeded = false;
  try {
    const installedFeatures = await integrationInstaller.applyAndRecordFeatures(
      state,
      integration,
      [application],
      { console, executionMode: 'update' },
    );
    succeeded = installedFeatures.length > 0;
  } catch (err) {
    logger.debug(
      `Global-scope coexistence collapse failed for ${integration.id}.${successor.id}: ${(err as Error).message}`,
    );
  }
  if (!succeeded) {
    return false;
  }

  await teardownStaleProjectEntries(state, integration, successor, projectEntries, console);
  installedIntegration.features = installedIntegration.features.filter(
    (feature) => !projectEntries.includes(feature),
  );
  return true;
}

/** Union, across every coexisting entry, of the subfeature ids still declared on the container. */
function unionActiveSubfeatureIds(
  container: FeatureContainer,
  entries: InstalledIntegrationFeature[],
): string[] {
  const declaredIds = new Set(container.subfeatures.map((subfeature) => subfeature.id));
  const active = new Set<string>();
  for (const entry of entries) {
    for (const id of effectiveActiveSubfeatureIds(entry, container)) {
      if (declaredIds.has(id)) {
        active.add(id);
      }
    }
  }
  return [...active];
}

/**
 * The subfeature ids active on one recorded entry: its own recorded set if present — even if
 * empty, a real "none active" signal distinct from `undefined` — otherwise the same
 * default-filtered fallback used for pre-container legacy installs.
 */
function effectiveActiveSubfeatureIds(
  entry: InstalledIntegrationFeature,
  container: FeatureContainer,
): string[] {
  if (entry.subfeatures) {
    return entry.subfeatures.map((subfeature) => subfeature.featureId);
  }
  return defaultEligibleSubfeatureIds(container, entry.attrs);
}

/**
 * Real teardown for *same-id* stale project entries (no rename involved), using the current
 * declaration's own resource/operation templates at each entry's own recorded targetRoot/attrs.
 * An entry reached via `replacedIds` (a rename alongside the scope promotion) has no declaration
 * left under its own id to resolve its resources with — the caller prunes its state entry
 * regardless, and `legacyCleanups` is the existing mechanism for real cleanup in that case, same
 * limitation as the `replacedIds` migration above.
 */
async function teardownStaleProjectEntries(
  state: CliState,
  integration: IntegrationDeclaration,
  successor: FeatureDeclaration,
  projectEntries: InstalledIntegrationFeature[],
  console: Console,
): Promise<void> {
  const sameIdEntries = projectEntries.filter(
    (entry) => entry.featureId === successor.id && fs.existsSync(entry.targetRoot),
  );
  if (sameIdEntries.length === 0) {
    return;
  }

  const applications: FeatureApplication[] = sameIdEntries.map((entry) => ({
    feature: successor,
    targetRoot: entry.targetRoot,
    scope: 'project',
    attrs: entry.attrs,
  }));

  try {
    await integrationInstaller.removeAndRecordFeatures(state, integration, applications, {
      console,
    });
  } catch (err) {
    logger.debug(
      `Failed to remove stale project-scope install of ${integration.id}.${successor.id}: ${(err as Error).message}`,
    );
  }
}
