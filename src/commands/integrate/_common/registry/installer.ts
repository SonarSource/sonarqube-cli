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
  InstalledIntegrationDependency,
  InstalledIntegrationFeature,
} from '../../../../lib/state.ts';
import type { DependencyDeclaration } from './dependencies';
import {
  findInstalledFeature,
  recordInstalledFeature,
  removeInstalledFeature,
} from './installation-recorder.ts';
import type { ResourceDeclaration } from './resources';
import { isFeatureContainer } from './selection.ts';
import type {
  AppliedFeature,
  AppliedOperation,
  AppliedResource,
  ContainerIntegrationContext,
  FeatureApplication,
  FeatureDeclaration,
  FeatureOperation,
  InstalledDependency,
  IntegrationContext,
  IntegrationDeclaration,
  IntegrationExecutionMode,
} from './types.ts';

function resolveVersion(version: string | undefined): string {
  return version ?? '0';
}

function resolveAllDeps<TOptions>(feature: FeatureDeclaration<TOptions>): DependencyDeclaration[] {
  return [
    ...(feature.dependencies ?? []),
    ...(isFeatureContainer(feature)
      ? feature.subfeatures.flatMap((s) => s.dependencies ?? [])
      : []),
  ];
}

interface ApplyFeatureCallbacks<TOptions = Record<string, unknown>> {
  onFeatureApplyStart?: (feature: FeatureDeclaration<TOptions>) => void;
  onDependencyInstalled?: (dependency: DependencyDeclaration) => void;
  onDependencySkipped?: (dependency: DependencyDeclaration) => void;
  onResourceInstalled?: (resource: ResourceDeclaration) => void;
  onResourceSkipped?: (resource: ResourceDeclaration) => void;
  onOperationApplied?: (operation: FeatureOperation) => void;
}

interface ApplyAndRecordFeaturesOptions<TOptions = Record<string, unknown>> {
  callbacks?: ApplyFeatureCallbacks<TOptions>;
  continueOnFeatureError?: boolean;
  executionMode?: IntegrationExecutionMode;
  onFeatureError?: (application: FeatureApplication<TOptions>, error: Error) => void;
}

interface PreparedFeatureExecution<TOptions = Record<string, unknown>> {
  application: FeatureApplication<TOptions>;
  context: IntegrationContext;
  installedFeature: InstalledIntegrationFeature | undefined;
}

interface PreparedDependencies {
  resolvedDependencies: Map<string, InstalledDependency>;
  installedDependencies: Map<string, InstalledDependency>;
  failedDependencies: Map<string, Error>;
}

interface UniqueDependencyExecution<TOptions = Record<string, unknown>> {
  dependency: DependencyDeclaration;
  execution: PreparedFeatureExecution<TOptions>;
}

export interface RemoveFeatureCallbacks<TOptions = Record<string, unknown>> {
  onFeatureRemoveStart?: (feature: FeatureDeclaration<TOptions>) => void;
  onResourceRemoved?: (resource: ResourceDeclaration) => void;
  onResourceSkipped?: (resource: ResourceDeclaration) => void;
  onOperationUndone?: (operation: FeatureOperation) => void;
  onDependencyRemoved?: (dependency: DependencyDeclaration) => void;
}

export class IntegrationInstaller {
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
    if (resolveVersion(installedDependency.version) !== resolveVersion(dependency.version)) {
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
    if (resolveVersion(installedResource.version) !== resolveVersion(resource.version)) {
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
    return (
      !installedOperation ||
      resolveVersion(installedOperation.version) !== resolveVersion(operation.version)
    );
  }

  async applyAndRecordFeatures<TOptions>(
    state: CliState,
    integration: IntegrationDeclaration<TOptions>,
    applications: FeatureApplication<TOptions>[],
    options: ApplyAndRecordFeaturesOptions<TOptions> = {},
  ): Promise<InstalledIntegrationFeature[]> {
    const executions = this.prepareFeatureExecutions(
      state,
      integration,
      applications,
      options.executionMode ?? 'install',
    );
    if (executions.length === 0) {
      return [];
    }

    const preparedDependencies = await this.prepareUniqueDependencies(
      executions,
      options.callbacks ?? {},
    );
    const installedFeatures: InstalledIntegrationFeature[] = [];

    for (const execution of executions) {
      try {
        options.callbacks?.onFeatureApplyStart?.(execution.application.feature);
        const applied = await this.applyFeatureWithUniqueDependencies(
          execution.context,
          execution.installedFeature,
          execution.application.feature,
          preparedDependencies,
          options.callbacks ?? {},
        );
        const feature = execution.application.feature;
        installedFeatures.push(
          recordInstalledFeature(
            state,
            execution.context,
            integration,
            feature,
            applied,
            isFeatureContainer(feature) ? feature.subfeatures : undefined,
          ),
        );
      } catch (error) {
        if (options.continueOnFeatureError !== true) {
          throw error;
        }
        options.onFeatureError?.(execution.application, error as Error);
      }
    }

    return installedFeatures;
  }

  async applyFeature<TOptions>(
    context: IntegrationContext,
    installedFeature: InstalledIntegrationFeature | undefined,
    feature: FeatureDeclaration<TOptions>,
    callbacks: ApplyFeatureCallbacks<TOptions> = {},
  ): Promise<AppliedFeature> {
    const preparedDependencies = await this.prepareUniqueDependencies(
      [
        {
          application: {
            feature,
            targetRoot: context.targetRoot,
            scope: context.scope,
            auth: context.auth,
            force: context.force,
            attrs: context.attrs,
          },
          context,
          installedFeature,
        },
      ],
      callbacks,
    );
    return this.applyFeatureWithUniqueDependencies(
      context,
      installedFeature,
      feature,
      preparedDependencies,
      callbacks,
    );
  }

  async removeFeature<TOptions>(
    context: IntegrationContext,
    feature: FeatureDeclaration<TOptions>,
    callbacks: RemoveFeatureCallbacks<TOptions> = {},
  ): Promise<void> {
    for (const resource of feature.resources ?? []) {
      await resource.remove(context);
      callbacks.onResourceRemoved?.(resource);
    }

    for (const cleanup of feature.legacyCleanups ?? []) {
      await cleanup.remove(context);
    }

    for (const operation of [...(feature.operations ?? [])].reverse()) {
      if (operation.undo) {
        await operation.undo(context);
        callbacks.onOperationUndone?.(operation);
      }
    }
  }

  /**
   * Remove the given features and update state: tear down each feature's
   * resources/operations, prune the recorded state entries, and uninstall any
   * binary dependency that becomes orphaned. Returns the removed feature
   * declarations.
   */
  async removeAndRecordFeatures<TOptions>(
    state: CliState,
    integration: IntegrationDeclaration<TOptions>,
    applications: FeatureApplication<TOptions>[],
    options: { callbacks?: RemoveFeatureCallbacks<TOptions> } = {},
  ): Promise<FeatureDeclaration<TOptions>[]> {
    const removed: FeatureDeclaration<TOptions>[] = [];

    for (const application of applications) {
      const feature = application.feature;
      const context = this.contextForApplication(state, application, 'install');

      options.callbacks?.onFeatureRemoveStart?.(feature);
      await this.removeFeature(context, feature, options.callbacks ?? {});

      const orphanedDependencies = removeInstalledFeature(state, context, integration, feature);
      const declaredDependencies = resolveAllDeps(feature);
      for (const orphaned of orphanedDependencies) {
        const declaration = declaredDependencies.find((dep) => dep.id === orphaned.id);
        if (declaration) {
          await declaration.remove(context);
          options.callbacks?.onDependencyRemoved?.(declaration);
        }
      }

      removed.push(feature);
    }

    return removed;
  }

  private async prepareUniqueDependencies<TOptions>(
    executions: PreparedFeatureExecution<TOptions>[],
    callbacks: ApplyFeatureCallbacks<TOptions> = {},
  ): Promise<PreparedDependencies> {
    const resolvedDependencies = new Map<string, InstalledDependency>();
    const installedDependencies = new Map<string, InstalledDependency>();
    const failedDependencies = new Map<string, Error>();

    for (const execution of this.collectUniqueDependencies(executions)) {
      const existingDependency = this.findInstalledDependency(
        execution.execution.context.state,
        execution.dependency,
      );
      const dependencyContext = {
        ...execution.execution.context,
        resolvedDependencies: this.makeResolvedDependencies(
          execution.execution.context.state,
          execution.execution.application.feature,
          resolvedDependencies,
        ),
      };

      if (!(await this.dependencyNeedsInstall(dependencyContext, execution.dependency))) {
        if (existingDependency) {
          resolvedDependencies.set(execution.dependency.id, existingDependency);
        }
        callbacks.onDependencySkipped?.(execution.dependency);
        continue;
      }

      try {
        const installedDependency = await execution.dependency.installOrUpdate({
          ...dependencyContext,
          existingDependency,
        });
        resolvedDependencies.set(installedDependency.id, installedDependency);
        installedDependencies.set(installedDependency.id, installedDependency);
        callbacks.onDependencyInstalled?.(execution.dependency);
      } catch (error) {
        failedDependencies.set(execution.dependency.id, error as Error);
      }
    }

    return { resolvedDependencies, installedDependencies, failedDependencies };
  }

  private async applyFeatureWithUniqueDependencies<TOptions>(
    context: IntegrationContext,
    installedFeature: InstalledIntegrationFeature | undefined,
    feature: FeatureDeclaration<TOptions>,
    preparedDependencies: PreparedDependencies,
    callbacks: ApplyFeatureCallbacks<TOptions> = {},
  ): Promise<AppliedFeature> {
    const dependencyIds = new Set<string>();
    const dependencies: InstalledDependency[] = [];
    const resources: AppliedResource[] = [];
    const operations: AppliedOperation[] = [];

    for (const dependency of resolveAllDeps(feature)) {
      const dependencyError = preparedDependencies.failedDependencies.get(dependency.id);
      if (dependencyError) {
        throw dependencyError;
      }

      const installedDependency = preparedDependencies.installedDependencies.get(dependency.id);
      if (installedDependency && !dependencyIds.has(dependency.id)) {
        dependencies.push(installedDependency);
        dependencyIds.add(dependency.id);
      }
    }

    const resolvedDependencies = this.makeResolvedDependencies(
      context.state,
      feature,
      preparedDependencies.resolvedDependencies,
    );
    const featureContext = this.buildFeatureContext(context, feature, resolvedDependencies);

    await this.cleanupRecordedLegacyInstallations(feature, featureContext);

    for (const resource of feature.resources ?? []) {
      if (!(await this.resourceNeedsApply(featureContext, installedFeature, resource))) {
        callbacks.onResourceSkipped?.(resource);
        continue;
      }
      resources.push(await resource.apply(featureContext));
      callbacks.onResourceInstalled?.(resource);
    }

    for (const operation of feature.operations ?? []) {
      if (operation.shouldApply && !(await operation.shouldApply(featureContext))) {
        continue;
      }
      await operation.apply(featureContext);
      operations.push({ id: operation.id, version: operation.version });
      callbacks.onOperationApplied?.(operation);
    }

    return { dependencies, resources, operations };
  }

  private buildFeatureContext<TOptions>(
    context: IntegrationContext,
    feature: FeatureDeclaration<TOptions>,
    resolvedDependencies: ReadonlyMap<string, InstalledDependency>,
  ): IntegrationContext {
    if (!isFeatureContainer(feature)) {
      return { ...context, resolvedDependencies };
    }
    return {
      ...context,
      resolvedDependencies,
      activeSubfeatures: feature.subfeatures,
    } as ContainerIntegrationContext;
  }

  private async cleanupRecordedLegacyInstallations<TOptions>(
    feature: FeatureDeclaration<TOptions>,
    featureContext: IntegrationContext,
  ) {
    for (const cleanup of feature.legacyCleanups ?? []) {
      await cleanup.remove(featureContext);
    }
  }

  private prepareFeatureExecutions<TOptions>(
    state: CliState,
    integration: IntegrationDeclaration<TOptions>,
    applications: FeatureApplication<TOptions>[],
    executionMode: IntegrationExecutionMode,
  ): PreparedFeatureExecution<TOptions>[] {
    return applications.map((application) => {
      const context = this.contextForApplication(state, application, executionMode);
      return {
        application,
        context,
        installedFeature: findInstalledFeature(state, context, integration, application.feature),
      };
    });
  }

  private contextForApplication<TOptions>(
    state: CliState,
    application: FeatureApplication<TOptions>,
    executionMode: IntegrationExecutionMode,
  ): IntegrationContext {
    return {
      state,
      targetRoot: application.targetRoot,
      scope: application.scope,
      executionMode,
      auth: application.auth,
      force: application.force,
      attrs: application.attrs,
      resolvedDependencies: new Map(),
    };
  }

  private collectUniqueDependencies<TOptions>(
    executions: PreparedFeatureExecution<TOptions>[],
  ): UniqueDependencyExecution<TOptions>[] {
    const dependencies = new Map<string, UniqueDependencyExecution<TOptions>>();

    for (const execution of executions) {
      for (const dependency of resolveAllDeps(execution.application.feature)) {
        const existing = dependencies.get(dependency.id);
        if (existing && existing.dependency !== dependency) {
          throw new Error(
            `Dependency ${dependency.id} is declared by multiple instances. Reuse the same dependency declaration when sharing a dependency across features.`,
          );
        }
        if (!existing) {
          dependencies.set(dependency.id, { dependency, execution });
        }
      }
    }

    return [...dependencies.values()];
  }

  private makeResolvedDependencies<TOptions>(
    state: CliState,
    feature: FeatureDeclaration<TOptions>,
    overrides: ReadonlyMap<string, InstalledDependency> = new Map(),
  ): Map<string, InstalledDependency> {
    const resolvedDependencies = new Map<string, InstalledDependency>();
    for (const dependency of resolveAllDeps(feature)) {
      const installedDependency =
        overrides.get(dependency.id) ?? this.findInstalledDependency(state, dependency);
      if (installedDependency) {
        resolvedDependencies.set(dependency.id, installedDependency);
      }
    }
    return resolvedDependencies;
  }
}

export const integrationInstaller = new IntegrationInstaller();
