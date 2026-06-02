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
import logger from '../../../../../lib/logger';
import { loadState, saveState } from '../../../../../lib/repository/state-repository';
import type {
  CliState,
  InstalledIntegration,
  InstalledIntegrationDependency,
  InstalledIntegrationDependencyReference,
  InstalledIntegrationFeature,
  InstalledIntegrationOperation,
  InstalledIntegrationResource,
  IntegrationScope,
  IntegrationStateAttribute,
} from '../../../../../lib/state';
import { getDefaultState } from '../../../../../lib/state';
import { info, success, text, warn } from '../../../../../ui';
import { CommandFailedError } from '../../../_common/error';
import { supportedIntegrations } from '../../index';
import type { IntegrationRegistry } from './core';
import type { DependencyDeclaration } from './dependencies';
import type { ResourceDeclaration } from './resources';
import type {
  AppliedFeature,
  AppliedOperation,
  AppliedResource,
  FeatureDeclaration,
  FeatureOperation,
  InstalledDependency,
  IntegrationContext,
  IntegrationDeclaration,
  IntegrationInvocation,
} from './types';

interface ApplyFeatureCallbacks {
  onDependencyInstalled?: (dependency: DependencyDeclaration) => void;
  onDependencySkipped?: (dependency: DependencyDeclaration) => void;
  onResourceInstalled?: (resource: ResourceDeclaration) => void;
  onResourceSkipped?: (resource: ResourceDeclaration) => void;
  onOperationApplied?: (operation: FeatureOperation) => void;
}

export interface InstallIntegrationOptions<TOptions> {
  registry?: IntegrationRegistry;
  integrationId: string;
  options: TOptions;
  targetRoot: string;
  scope: IntegrationScope;
  force?: boolean;
  attrs?: Record<string, IntegrationStateAttribute>;
}

export class IntegrationInstaller {
  selectFeatures(integration: IntegrationDeclaration, featureIds: string[]): FeatureDeclaration[] {
    const featuresById = new Map(integration.features.map((feature) => [feature.id, feature]));
    return featureIds.map((id) => {
      const feature = featuresById.get(id);
      if (!feature) {
        throw new Error(`Unknown feature ${integration.id}.${id}`);
      }
      return feature;
    });
  }

  selectFeaturesForInvocation<TOptions>(
    integration: IntegrationDeclaration<TOptions>,
    invocation: IntegrationInvocation<TOptions>,
  ): FeatureDeclaration<TOptions>[] {
    return integration.features.filter((feature) => !feature.when || feature.when(invocation));
  }

  findInstalledFeature<TOptions>(
    state: CliState,
    context: Omit<IntegrationContext, 'state'>,
    integration: IntegrationDeclaration<TOptions>,
    feature: FeatureDeclaration<TOptions>,
  ): InstalledIntegrationFeature | undefined {
    return this.findInstalledIntegration(state, integration)?.features.find(
      (entry) =>
        entry.featureId === feature.id &&
        entry.scope === context.scope &&
        entry.targetRoot === context.targetRoot,
    );
  }

  findInstalledIntegration<TOptions>(
    state: CliState,
    integration: IntegrationDeclaration<TOptions>,
  ): InstalledIntegration | undefined {
    return state.integrations.installed.find((entry) => entry.integrationId === integration.id);
  }

  findInstalledDependency(
    state: CliState,
    dependency: DependencyDeclaration,
  ): InstalledIntegrationDependency | undefined {
    return state.dependencies.installed.find((entry) => entry.id === dependency.id);
  }

  async dependencyNeedsInstall(
    context: IntegrationContext,
    dependency: DependencyDeclaration,
  ): Promise<boolean> {
    const installedDependency = this.findInstalledDependency(context.state, dependency);
    if (!installedDependency) {
      return true;
    }
    if (installedDependency.version !== dependency.version) {
      return true;
    }
    return !(await dependency.isInstalled(context));
  }

  async resourceNeedsApply(
    context: IntegrationContext,
    installedFeature: InstalledIntegrationFeature | undefined,
    resource: ResourceDeclaration,
  ): Promise<boolean> {
    const installedResource = installedFeature?.resources.find((entry) => entry.id === resource.id);
    if (!installedResource) {
      return true;
    }
    if (installedResource.version !== resource.version) {
      return true;
    }
    return !(await resource.isApplied(context));
  }

  operationNeedsApply(
    installedFeature: InstalledIntegrationFeature | undefined,
    operation: FeatureOperation,
  ): boolean {
    const installedOperation = installedFeature?.operations.find(
      (entry) => entry.id === operation.id,
    );
    return !installedOperation || installedOperation.version !== operation.version;
  }

  async applyFeature<TOptions>(
    context: IntegrationContext,
    installedFeature: InstalledIntegrationFeature | undefined,
    feature: FeatureDeclaration<TOptions>,
    callbacks: ApplyFeatureCallbacks = {},
  ): Promise<AppliedFeature> {
    const dependencies: InstalledDependency[] = [];
    const resources: AppliedResource[] = [];
    const operations: AppliedOperation[] = [];

    for (const dependency of feature.dependencies ?? []) {
      if (!(await this.dependencyNeedsInstall(context, dependency))) {
        callbacks.onDependencySkipped?.(dependency);
        continue;
      }
      dependencies.push(await dependency.install(context));
      callbacks.onDependencyInstalled?.(dependency);
    }

    for (const resource of feature.resources ?? []) {
      if (!(await this.resourceNeedsApply(context, installedFeature, resource))) {
        callbacks.onResourceSkipped?.(resource);
        continue;
      }
      resources.push(await resource.apply(context));
      callbacks.onResourceInstalled?.(resource);
    }

    for (const operation of feature.operations ?? []) {
      if (operation.shouldApply && !(await operation.shouldApply(context))) {
        continue;
      }
      await operation.apply(context);
      operations.push({ id: operation.id, version: operation.version });
      callbacks.onOperationApplied?.(operation);
    }

    return { dependencies, resources, operations };
  }

  async applyAndRecordFeature<TOptions>(
    context: IntegrationContext,
    integration: IntegrationDeclaration<TOptions>,
    feature: FeatureDeclaration<TOptions>,
    callbacks: ApplyFeatureCallbacks = {},
  ): Promise<InstalledIntegrationFeature> {
    const installedFeature = this.findInstalledFeature(
      context.state,
      context,
      integration,
      feature,
    );
    const applied = await this.applyFeature(context, installedFeature, feature, callbacks);
    return this.recordInstalledFeature(context.state, context, integration, feature, applied);
  }

  recordInstalledFeature<TOptions>(
    state: CliState,
    context: Omit<IntegrationContext, 'state'>,
    integration: IntegrationDeclaration<TOptions>,
    feature: FeatureDeclaration<TOptions>,
    applied: AppliedFeature,
  ): InstalledIntegrationFeature {
    const now = new Date().toISOString();
    const installedIntegration = this.upsertInstalledIntegration(state, integration, now);
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
      dependencies: this.upsertDependencyReferences(
        existing?.dependencies ?? [],
        new Set((feature.dependencies ?? []).map((dependency) => dependency.id)),
      ),
      resources: this.upsertResources(
        existing?.resources ?? [],
        applied.resources,
        now,
        new Set((feature.resources ?? []).map((resource) => resource.id)),
      ),
      operations: this.upsertOperations(
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

    state.dependencies.installed = this.upsertDependencies(
      state.dependencies.installed,
      applied.dependencies,
      now,
      this.collectReferencedDependencyIds(state),
    );

    return existing ?? next;
  }

  private upsertInstalledIntegration<TOptions>(
    state: CliState,
    integration: IntegrationDeclaration<TOptions>,
    now: string,
  ): InstalledIntegration {
    const existing = this.findInstalledIntegration(state, integration);
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

  private upsertDependencyReferences(
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

  private upsertDependencies(
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

  private upsertResources(
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

  private upsertOperations(
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

  private collectReferencedDependencyIds(state: CliState): Set<string> {
    return new Set(
      state.integrations.installed.flatMap((integration) =>
        integration.features.flatMap((feature) =>
          feature.dependencies.map((dependency) => dependency.id),
        ),
      ),
    );
  }
}

export const integrationInstaller = new IntegrationInstaller();

export async function installIntegration<TOptions>({
  registry = supportedIntegrations,
  integrationId,
  options,
  targetRoot,
  scope,
  force,
  attrs,
}: InstallIntegrationOptions<TOptions>): Promise<InstalledIntegrationFeature[]> {
  const integration = getIntegrationDeclaration<TOptions>(registry, integrationId);
  const invocation = makeInvocation(options, targetRoot, scope, force, attrs);
  const features = integrationInstaller.selectFeaturesForInvocation(integration, invocation);
  if (features.length === 0) {
    throw new CommandFailedError(`No feature selected for ${integration.displayName}`);
  }

  const installedFeatures: InstalledIntegrationFeature[] = [];
  for (const feature of features) {
    const context = await resolveFeatureContext(loadStateForInstallation(), invocation, feature);
    const installedFeature = integrationInstaller.findInstalledFeature(
      context.state,
      context,
      integration,
      feature,
    );
    text(`Installing ${integration.displayName}: ${feature.displayName}`);
    const applied = await integrationInstaller.applyFeature(context, installedFeature, feature, {
      onDependencyInstalled: (dependency) => {
        success(`Installed ${dependency.displayName ?? dependency.id}`);
      },
      onDependencySkipped: (dependency) => {
        info(`${dependency.displayName ?? dependency.id} already installed`);
      },
      onResourceInstalled: (resource) => {
        success(`Installed ${resource.displayName ?? resource.id}`);
      },
      onResourceSkipped: (resource) => {
        info(`${resource.displayName ?? resource.id} already installed`);
      },
      onOperationApplied: (operation) => {
        success(`Applied ${operation.displayName ?? operation.id}`);
      },
    });
    const installed = recordFeatureInstallation(integration, feature, context, applied);
    if (installed) {
      installedFeatures.push(installed);
    }
  }

  return installedFeatures;
}

function recordFeatureInstallation<TOptions>(
  integration: IntegrationDeclaration<TOptions>,
  feature: FeatureDeclaration<TOptions>,
  context: Omit<IntegrationContext, 'state'>,
  applied: AppliedFeature,
): InstalledIntegrationFeature | undefined {
  try {
    const state = loadState();
    const featureContext = makeContext(
      state,
      context.targetRoot,
      context.scope,
      context.force,
      context.attrs,
    );
    const installed = integrationInstaller.recordInstalledFeature(
      state,
      featureContext,
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
  force: boolean | undefined,
  attrs: Record<string, IntegrationStateAttribute> | undefined,
): IntegrationInvocation<TOptions> {
  return {
    options,
    targetRoot,
    scope,
    force,
    attrs,
  };
}

async function resolveFeatureContext<TOptions>(
  state: CliState,
  invocation: IntegrationInvocation<TOptions>,
  feature: FeatureDeclaration<TOptions>,
): Promise<IntegrationContext> {
  return makeContext(
    state,
    await resolveFeatureTargetRoot(invocation, feature),
    await resolveFeatureScope(invocation, feature),
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
