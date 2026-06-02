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

import { version as VERSION } from '../../../../../../package.json';
import type {
  CliState,
  InstalledIntegration,
  InstalledIntegrationDependency,
  InstalledIntegrationDependencyReference,
  InstalledIntegrationFeature,
  InstalledIntegrationOperation,
  InstalledIntegrationResource,
} from '../../../../../lib/state';
import type {
  AppliedFeature,
  AppliedOperation,
  AppliedResource,
  FeatureDeclaration,
  InstalledDependency,
  IntegrationContext,
  IntegrationDeclaration,
} from './types';

export function recordInstalledFeature<TOptions>(
  state: CliState,
  context: Omit<IntegrationContext, 'state'>,
  integration: IntegrationDeclaration<TOptions>,
  feature: FeatureDeclaration<TOptions>,
  applied: AppliedFeature,
): InstalledIntegrationFeature {
  const now = new Date().toISOString();
  const installedIntegration = upsertInstalledIntegration(state, integration, now);
  const existing = installedIntegration.features.find(
    (entry) =>
      entry.featureId === feature.id &&
      entry.scope === context.scope &&
      entry.targetRoot === context.targetRoot,
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
      new Set((feature.dependencies ?? []).map((dependency) => dependency.id)),
    ),
    resources: upsertResources(
      existing?.resources ?? [],
      applied.resources,
      now,
      new Set((feature.resources ?? []).map((resource) => resource.id)),
    ),
    operations: upsertOperations(
      existing?.operations ?? [],
      applied.operations,
      now,
      new Set((feature.operations ?? []).map((operation) => operation.id)),
    ),
    attrs: context.attrs,
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

export function collectReferencedDependencyIds(state: CliState): Set<string> {
  return new Set(
    state.integrations.installed.flatMap((integration) =>
      integration.features.flatMap((feature) =>
        feature.dependencies.map((dependency) => dependency.id),
      ),
    ),
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
  for (const resource of applied) {
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
  for (const operation of applied) {
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
