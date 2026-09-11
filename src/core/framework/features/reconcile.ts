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
import { homedir } from 'node:os';

import logger from '@/core/observability/logger.ts';
import type {
  CliState,
  InstalledIntegration,
  InstalledIntegrationFeature,
  IntegrationStateAttribute,
} from '@/core/state/state.ts';
import type { Console } from '@/core/ui/console.ts';

import { resolveFeatureTargetRoot } from './feature-target.ts';
import { findInstalledIntegration } from './installation-recorder.ts';
import { integrationInstaller } from './installer.ts';
import type { IntegrationRegistry } from './registry.ts';
import { normalizeDecision } from './selection.ts';
import type {
  FeatureApplication,
  FeatureContainer,
  FeatureDeclaration,
  IntegrationDeclaration,
  SubfeatureDeclaration,
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

  // Last step, once every entry above is current: fold every project-scope install of a
  // feature into a single global record, producing one if none exists yet.
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

/** Drops any subfeature whose own pinned scope disagrees with the application's, so a scope change in a later release is enforced on every reapply, not just during fold. */
function getFeature(
  featuresById: Map<string, FeatureDeclaration>,
  featureId: string,
  subfeatureIds: string[] | undefined,
  scope: InstalledIntegrationFeature['scope'],
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
      subfeatures: feature.subfeatures.filter(
        (s) => activeIds.has(s.id) && (s.scope === undefined || s.scope === scope),
      ),
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
  const feature = getFeature(featuresById, featureId, subfeatureIds, scope, attrs);
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

/** Folds project-scope installs into one global record, producing one if none exists. Matches only successor.id, never replacedIds (a predecessor entry is pending retry). */
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
    const folded = await foldProjectEntriesIntoGlobal(
      state,
      integration,
      installedIntegration,
      featuresById,
      successor,
      console,
    );
    if (folded) {
      stateChanged = true;
    }
  }
  return stateChanged;
}

/**
 * A literal `scope: 'project'` on a feature already means "never run this at global scope" —
 * Vortex's container already relies on exactly this to stay project-only.
 */
function isGlobalScopeEligible(feature: FeatureDeclaration): boolean {
  return feature.scope !== 'project';
}

async function foldProjectEntriesIntoGlobal(
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

  const coexisting = installedIntegration.features.filter(
    (feature) => feature.featureId === successor.id,
  );
  const globalEntry = coexisting.find((feature) => feature.scope === 'global');
  const projectEntries = coexisting.filter((feature) => feature.scope === 'project');
  if (projectEntries.length === 0) {
    return false;
  }

  const application = globalEntry
    ? buildUpdateExistingGlobalApplication(
        featuresById,
        successor,
        coexisting,
        globalEntry,
        projectEntries,
      )
    : await buildNewGlobalApplication(state, featuresById, successor, projectEntries);
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
      `Global-scope fold failed for ${integration.id}.${successor.id}: ${(err as Error).message}`,
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

/** Builds the merge application for a feature that already has a global record. */
function buildUpdateExistingGlobalApplication(
  featuresById: Map<string, FeatureDeclaration>,
  successor: FeatureDeclaration,
  coexisting: InstalledIntegrationFeature[],
  globalEntry: InstalledIntegrationFeature,
  projectEntries: InstalledIntegrationFeature[],
): FeatureApplication | undefined {
  const subfeatureIds = isFeatureContainer(successor)
    ? unionActiveSubfeatureIds(successor, coexisting)
    : undefined;
  return createFeatureApplication(
    featuresById,
    successor.id,
    subfeatureIds,
    globalEntry.targetRoot,
    'global',
    mergeFeatureAttrs([...projectEntries, globalEntry]),
  );
}

/** Builds the application for a feature with no global record yet — a genuinely new install. */
async function buildNewGlobalApplication(
  state: CliState,
  featuresById: Map<string, FeatureDeclaration>,
  successor: FeatureDeclaration,
  projectEntries: InstalledIntegrationFeature[],
): Promise<FeatureApplication | undefined> {
  const targetRoot = await resolveFeatureTargetRoot(
    { options: {}, targetRoot: homedir(), scope: 'global', state },
    successor,
  );
  const attrs = mergeFeatureAttrs(projectEntries);
  const subfeatureIds = isFeatureContainer(successor)
    ? await resolveNewGlobalSubfeatureIds(successor, projectEntries, state, targetRoot, attrs)
    : undefined;
  return createFeatureApplication(
    featuresById,
    successor.id,
    subfeatureIds,
    targetRoot,
    'global',
    attrs,
  );
}

/** Subfeature ids to carry onto an already-existing global record: union of what's active anywhere, dropping any pinned to project scope. */
function unionActiveSubfeatureIds(
  container: FeatureContainer,
  entries: InstalledIntegrationFeature[],
): string[] {
  const active = new Set<string>();
  for (const entry of entries) {
    for (const id of effectiveActiveSubfeatureIds(entry, container)) {
      active.add(id);
    }
  }
  return container.subfeatures
    .filter((subfeature) => subfeature.scope !== 'project' && active.has(subfeature.id))
    .map((subfeature) => subfeature.id);
}

/** Subfeature ids for a brand-new global record: 'project' dropped, 'global' decided via shouldInstall, undefined carried if active on a project entry being promoted. */
async function resolveNewGlobalSubfeatureIds(
  container: FeatureContainer,
  projectEntries: InstalledIntegrationFeature[],
  state: CliState,
  targetRoot: string,
  attrs: InstalledIntegrationFeature['attrs'],
): Promise<string[]> {
  const activeOnProject = new Set<string>();
  for (const entry of projectEntries) {
    for (const id of effectiveActiveSubfeatureIds(entry, container)) {
      activeOnProject.add(id);
    }
  }

  const resolved: string[] = [];
  for (const subfeature of container.subfeatures) {
    if (subfeature.scope === 'project') {
      continue;
    }
    if (subfeature.scope === 'global') {
      if (await shouldInstallGlobalSubfeature(subfeature, state, targetRoot, attrs)) {
        resolved.push(subfeature.id);
      }
      continue;
    }
    if (activeOnProject.has(subfeature.id)) {
      resolved.push(subfeature.id);
    }
  }
  return resolved;
}

/** Non-interactive shouldInstall check; nonInteractive: true resolves an 'ask' decision to install. */
async function shouldInstallGlobalSubfeature(
  subfeature: SubfeatureDeclaration,
  state: CliState,
  targetRoot: string,
  attrs: InstalledIntegrationFeature['attrs'],
): Promise<boolean> {
  const decision = normalizeDecision(
    await subfeature.shouldInstall?.({
      options: {},
      targetRoot,
      scope: 'global',
      attrs,
      nonInteractive: true,
      state,
    }),
  );
  return decision.action !== 'skip' && decision.action !== 'uninstall';
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

/** Real teardown for the stale (always same-id) project entries being folded into the global record. */
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
