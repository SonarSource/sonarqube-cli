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

import { randomUUID } from 'node:crypto';

import type {
  CliState,
  InstalledIntegration,
  InstalledIntegrationDependency,
  InstalledIntegrationDependencyReference,
  InstalledIntegrationFeature,
  InstalledIntegrationOperation,
  InstalledIntegrationResource,
  InstalledSubfeature,
  IntegrationScope,
} from '@/core/state/state.ts';

import { version as VERSION } from '../../../../package.json';
import type {
  AppliedFeature,
  AppliedOperation,
  AppliedResource,
  FeatureDeclaration,
  InstalledDependency,
  IntegrationContext,
  IntegrationDeclaration,
  SubfeatureDeclaration,
} from './types.ts';
import { isFeatureContainer } from './types.ts';

function toIdSet(entries: { id: string }[]): Set<string> {
  return new Set(entries.map((entry) => entry.id));
}

/** Resources recorded for a feature, including those owned by its active subfeatures. */
export function recordedFeatureResources(
  feature: InstalledIntegrationFeature,
): InstalledIntegrationResource[] {
  return [
    ...feature.resources,
    ...(feature.subfeatures?.flatMap((subfeature) => subfeature.resources ?? []) ?? []),
  ];
}

/** Operations recorded for a feature, including those owned by its active subfeatures. */
export function recordedFeatureOperations(
  feature: InstalledIntegrationFeature,
): InstalledIntegrationOperation[] {
  return [
    ...feature.operations,
    ...(feature.subfeatures?.flatMap((subfeature) => subfeature.operations ?? []) ?? []),
  ];
}

function recordSubfeature<TOptions>(
  subfeature: SubfeatureDeclaration<TOptions>,
  existing: InstalledSubfeature | undefined,
  applied: AppliedFeature,
  now: string,
): InstalledSubfeature {
  return {
    featureId: subfeature.id,
    dependencies: upsertDependencyReferences(
      existing?.dependencies ?? [],
      toIdSet(subfeature.dependencies ?? []),
    ),
    resources: upsertResources(
      existing?.resources ?? [],
      applied.resources,
      now,
      toIdSet(subfeature.resources ?? []),
    ),
    operations: upsertOperations(
      existing?.operations ?? [],
      applied.operations,
      now,
      toIdSet(subfeature.operations ?? []),
    ),
  };
}

/** Match a recorded feature entry by its id + scope + targetRoot key. */
function matchesFeatureKey<TOptions>(
  entry: InstalledIntegrationFeature,
  context: Pick<IntegrationContext, 'scope' | 'targetRoot'>,
  feature: FeatureDeclaration<TOptions>,
): boolean {
  return (
    entry.featureId === feature.id &&
    entry.scope === context.scope &&
    entry.targetRoot === context.targetRoot
  );
}

export function recordInstalledFeature<TOptions>(
  state: CliState,
  context: Omit<IntegrationContext, 'state'>,
  integration: IntegrationDeclaration<TOptions>,
  feature: FeatureDeclaration<TOptions>,
  applied: AppliedFeature,
): InstalledIntegrationFeature {
  const now = new Date().toISOString();
  const installedIntegration = upsertInstalledIntegration(state, integration, now);
  const existing = installedIntegration.features.find((entry) =>
    matchesFeatureKey(entry, context, feature),
  );
  const next: InstalledIntegrationFeature = {
    featureId: feature.id,
    scope: context.scope,
    targetRoot: context.targetRoot,
    installedByCliVersion: existing?.installedByCliVersion ?? VERSION,
    installedAt: existing?.installedAt ?? now,
    updatedByCliVersion: VERSION,
    updatedAt: now,
    dependencies: upsertDependencyReferences(
      existing?.dependencies ?? [],
      toIdSet(feature.dependencies ?? []),
    ),
    resources: upsertResources(
      existing?.resources ?? [],
      applied.resources,
      now,
      toIdSet(feature.resources ?? []),
    ),
    operations: upsertOperations(
      existing?.operations ?? [],
      applied.operations,
      now,
      toIdSet(feature.operations ?? []),
    ),
    attrs: context.attrs,
    subfeatures: isFeatureContainer(feature)
      ? feature.subfeatures.map((subfeature) =>
          recordSubfeature(
            subfeature,
            existing?.subfeatures?.find((entry) => entry.featureId === subfeature.id),
            applied,
            now,
          ),
        )
      : undefined,
  };

  if (existing) {
    Object.assign(existing, next);
  } else {
    installedIntegration.features.push(next);
  }

  state.dependencies.installed = upsertDependencies(
    state.dependencies.installed,
    applied.dependencies,
    now,
    collectReferencedDependencyIds(state),
  );

  return existing ?? next;
}

/**
 * Remove a recorded feature from state, matching by id + scope + targetRoot
 * (same key as {@link recordInstalledFeature}), and drop the owning integration
 * entry when no features remain. Prunes dependencies of the removed feature from
 * state and returns the orphaned ones so the caller can delete their binaries.
 */
export function removeInstalledFeature<TOptions>(
  state: CliState,
  context: Pick<IntegrationContext, 'scope' | 'targetRoot'>,
  integration: IntegrationDeclaration<TOptions>,
  feature: FeatureDeclaration<TOptions>,
): InstalledIntegrationDependency[] {
  const installedIntegration = state.integrations.installed.find(
    (entry) => entry.integrationId === integration.id,
  );
  if (!installedIntegration) {
    return [];
  }

  const featureIndex = installedIntegration.features.findIndex((entry) =>
    matchesFeatureKey(entry, context, feature),
  );
  if (featureIndex < 0) {
    return [];
  }

  const [removedFeature] = installedIntegration.features.splice(featureIndex, 1);
  const removedDependencyIds = new Set(featureDependencyIds(removedFeature));

  if (installedIntegration.features.length === 0) {
    state.integrations.installed = state.integrations.installed.filter(
      (entry) => entry !== installedIntegration,
    );
  }

  const stillReferenced = collectReferencedDependencyIds(state);
  const orphanedIds = new Set([...removedDependencyIds].filter((id) => !stillReferenced.has(id)));
  if (orphanedIds.size === 0) {
    return [];
  }

  const orphanedDependencies = state.dependencies.installed.filter((dependency) =>
    orphanedIds.has(dependency.id),
  );
  state.dependencies.installed = state.dependencies.installed.filter(
    (dependency) => !orphanedIds.has(dependency.id),
  );
  return orphanedDependencies;
}

function featureDependencyIds(feature: InstalledIntegrationFeature): string[] {
  return [
    ...feature.dependencies.map((d) => d.id),
    ...(feature.subfeatures?.flatMap((sub) => sub.dependencies.map((d) => d.id)) ?? []),
  ];
}

export function collectReferencedDependencyIds(state: CliState): Set<string> {
  return new Set(
    state.integrations.installed.flatMap((integration) =>
      integration.features.flatMap(featureDependencyIds),
    ),
  );
}

/** Find the recorded integration entry, or `undefined` if the integration has none. */
export function findInstalledIntegration<TOptions>(
  state: CliState,
  integration: IntegrationDeclaration<TOptions>,
): InstalledIntegration | undefined {
  return state.integrations.installed.find((entry) => entry.integrationId === integration.id);
}

/** Find a recorded feature by id + scope + targetRoot, or `undefined` if not installed. */
export function findInstalledFeature<TOptions>(
  state: CliState,
  context: Pick<IntegrationContext, 'scope' | 'targetRoot'>,
  integration: IntegrationDeclaration<TOptions>,
  feature: FeatureDeclaration<TOptions>,
): InstalledIntegrationFeature | undefined {
  return findInstalledIntegration(state, integration)?.features.find((entry) =>
    matchesFeatureKey(entry, context, feature),
  );
}

/** True for a project install whose `featureId` already has a recorded global install. */
export function isFeatureInstalledGloballyForProject(
  state: CliState | undefined,
  scope: IntegrationScope,
  integrationId: string,
  featureId: string,
): boolean {
  return (
    scope === 'project' &&
    state !== undefined &&
    (state.integrations.installed
      .find((integration) => integration.integrationId === integrationId)
      ?.features.some((feature) => feature.featureId === featureId && feature.scope === 'global') ??
      false)
  );
}

function upsertInstalledIntegration<TOptions>(
  state: CliState,
  integration: IntegrationDeclaration<TOptions>,
  now: string,
): InstalledIntegration {
  const existing = state.integrations.installed.find(
    (entry) => entry.integrationId === integration.id,
  );
  if (existing) {
    existing.updatedByCliVersion = VERSION;
    existing.updatedAt = now;
    return existing;
  }

  const next: InstalledIntegration = {
    id: randomUUID(),
    integrationId: integration.id,
    installedByCliVersion: VERSION,
    installedAt: now,
    updatedByCliVersion: VERSION,
    updatedAt: now,
    features: [],
  };
  state.integrations.installed.push(next);
  return next;
}

function upsertDependencyReferences(
  existing: InstalledIntegrationDependencyReference[],
  declaredIds: Set<string>,
): InstalledIntegrationDependencyReference[] {
  return existing
    .filter((dependency) => declaredIds.has(dependency.id))
    .concat(
      [...declaredIds]
        .filter((id) => !existing.some((dependency) => dependency.id === id))
        .map((id) => ({ id })),
    );
}

function upsertDependencies(
  existing: InstalledIntegrationDependency[],
  applied: InstalledDependency[],
  now: string,
  referencedIds: Set<string>,
): InstalledIntegrationDependency[] {
  const dependencies = existing.filter((dependency) => referencedIds.has(dependency.id));
  for (const dependency of applied) {
    const next: InstalledIntegrationDependency = {
      ...dependency,
      updatedByCliVersion: VERSION,
      updatedAt: now,
    };
    const index = dependencies.findIndex((entry) => entry.id === dependency.id);
    if (index >= 0) {
      dependencies[index] = next;
    } else {
      dependencies.push(next);
    }
  }
  return dependencies;
}

function upsertResources(
  existing: InstalledIntegrationResource[],
  applied: AppliedResource[],
  now: string,
  declaredIds: Set<string>,
): InstalledIntegrationResource[] {
  const resources = existing.filter((entry) => declaredIds.has(entry.id));
  for (const resource of applied.filter((entry) => declaredIds.has(entry.id))) {
    const next: InstalledIntegrationResource = {
      ...resource,
      updatedByCliVersion: VERSION,
      updatedAt: now,
    };
    const index = resources.findIndex((entry) => entry.id === resource.id);
    if (index >= 0) {
      resources[index] = next;
    } else {
      resources.push(next);
    }
  }
  return resources;
}

function upsertOperations(
  existing: InstalledIntegrationOperation[],
  applied: AppliedOperation[],
  now: string,
  declaredIds: Set<string>,
): InstalledIntegrationOperation[] {
  const operations = existing.filter((entry) => declaredIds.has(entry.id));
  for (const operation of applied.filter((entry) => declaredIds.has(entry.id))) {
    const next: InstalledIntegrationOperation = {
      ...operation,
      updatedByCliVersion: VERSION,
      updatedAt: now,
    };
    const index = operations.findIndex((entry) => entry.id === operation.id);
    if (index >= 0) {
      operations[index] = next;
    } else {
      operations.push(next);
    }
  }
  return operations;
}
