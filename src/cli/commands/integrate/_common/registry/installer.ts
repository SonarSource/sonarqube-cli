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

import type { ResolvedAuth } from '../../../../../lib/auth-resolver';
import type {
  CliState,
  InstalledIntegration,
  InstalledIntegrationDependency,
  InstalledIntegrationFeature,
  IntegrationScope,
  IntegrationStateAttribute,
} from '../../../../../lib/state';
import { confirmPrompt, info } from '../../../../../ui';
import type { DependencyDeclaration } from './dependencies';
import { recordInstalledFeature } from './installation-recorder';
import type { ResourceDeclaration } from './resources';
import { normalizeDecision } from './selection';
import type {
  AppliedFeature,
  AppliedOperation,
  AppliedResource,
  FeatureDeclaration,
  FeatureOperation,
  InstalledDependency,
  IntegrationContext,
  IntegrationDeclaration,
  IntegrationExecutionMode,
  IntegrationInvocation,
} from './types';

interface ApplyFeatureCallbacks {
  onDependencyInstalled?: (dependency: DependencyDeclaration) => void;
  onDependencySkipped?: (dependency: DependencyDeclaration) => void;
  onResourceInstalled?: (resource: ResourceDeclaration) => void;
  onResourceSkipped?: (resource: ResourceDeclaration) => void;
  onOperationApplied?: (operation: FeatureOperation) => void;
}

export interface FeatureApplication<TOptions = Record<string, unknown>> {
  feature: FeatureDeclaration<TOptions>;
  targetRoot: string;
  scope: IntegrationScope;
  auth?: ResolvedAuth;
  force?: boolean;
  attrs?: Record<string, IntegrationStateAttribute>;
}

interface ApplyAndRecordFeaturesOptions<TOptions = Record<string, unknown>> {
  callbacks?: ApplyFeatureCallbacks;
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

export interface RemoveFeatureCallbacks {
  onResourceRemoved?: (resource: ResourceDeclaration) => void;
  onResourceSkipped?: (resource: ResourceDeclaration) => void;
  onOperationUndone?: (operation: FeatureOperation) => void;
}

export class IntegrationInstaller {
  selectFeatures<TOptions>(
    integration: IntegrationDeclaration<TOptions>,
    featureIds: string[],
  ): FeatureDeclaration<TOptions>[] {
    const featuresById = new Map(integration.features.map((feature) => [feature.id, feature]));
    return featureIds.map((id) => {
      const feature = featuresById.get(id);
      if (!feature) {
        throw new Error(`Unknown feature ${integration.id}.${id}`);
      }
      return feature;
    });
  }

  async selectFeaturesForInvocation<TOptions>(
    integration: IntegrationDeclaration<TOptions>,
    invocation: IntegrationInvocation<TOptions>,
  ): Promise<FeatureDeclaration<TOptions>[]> {
    const selected: FeatureDeclaration<TOptions>[] = [];
    for (const feature of integration.features) {
      if (await this.shouldInstallFeature(feature, invocation)) {
        selected.push(feature);
      }
    }
    return selected;
  }

  private async shouldInstallFeature<TOptions>(
    feature: FeatureDeclaration<TOptions>,
    invocation: IntegrationInvocation<TOptions>,
  ): Promise<boolean> {
    const decision = normalizeDecision(await feature.shouldInstall?.(invocation));
    switch (decision.action) {
      case 'install':
        return true;
      case 'skip':
        if (decision.message) {
          info(decision.message);
        }
        return false;
      case 'ask': {
        if ((invocation.options as { nonInteractive?: boolean }).nonInteractive) {
          return true;
        }
        const confirmed = await confirmPrompt(
          decision.message ?? `Install ${feature.displayName}?`,
          true,
        );
        return confirmed === true;
      }
    }
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
        const applied = await this.applyFeatureWithUniqueDependencies(
          execution.context,
          execution.installedFeature,
          execution.application.feature,
          preparedDependencies,
          options.callbacks ?? {},
        );
        installedFeatures.push(
          recordInstalledFeature(
            state,
            execution.context,
            integration,
            execution.application.feature,
            applied,
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
    callbacks: ApplyFeatureCallbacks = {},
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
    callbacks: RemoveFeatureCallbacks = {},
  ): Promise<void> {
    for (const resource of feature.resources ?? []) {
      if (resource.remove) {
        await resource.remove(context);
        callbacks.onResourceRemoved?.(resource);
      } else {
        callbacks.onResourceSkipped?.(resource);
      }
    }

    for (const operation of [...(feature.operations ?? [])].reverse()) {
      if (operation.undo) {
        await operation.undo(context);
        callbacks.onOperationUndone?.(operation);
      }
    }
  }

  private async prepareUniqueDependencies<TOptions>(
    executions: PreparedFeatureExecution<TOptions>[],
    callbacks: ApplyFeatureCallbacks = {},
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
    callbacks: ApplyFeatureCallbacks = {},
  ): Promise<AppliedFeature> {
    const dependencyIds = new Set<string>();
    const dependencies: InstalledDependency[] = [];
    const resources: AppliedResource[] = [];
    const operations: AppliedOperation[] = [];

    for (const dependency of feature.dependencies ?? []) {
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
    const featureContext = { ...context, resolvedDependencies };

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

  private prepareFeatureExecutions<TOptions>(
    state: CliState,
    integration: IntegrationDeclaration<TOptions>,
    applications: FeatureApplication<TOptions>[],
    executionMode: IntegrationExecutionMode,
  ): PreparedFeatureExecution<TOptions>[] {
    return applications.map((application) => {
      const context: IntegrationContext = {
        state,
        targetRoot: application.targetRoot,
        scope: application.scope,
        executionMode,
        auth: application.auth,
        force: application.force,
        attrs: application.attrs,
        resolvedDependencies: new Map(),
      };
      return {
        application,
        context,
        installedFeature: this.findInstalledFeature(
          state,
          context,
          integration,
          application.feature,
        ),
      };
    });
  }

  private collectUniqueDependencies<TOptions>(
    executions: PreparedFeatureExecution<TOptions>[],
  ): UniqueDependencyExecution<TOptions>[] {
    const dependencies = new Map<string, UniqueDependencyExecution<TOptions>>();

    for (const execution of executions) {
      for (const dependency of execution.application.feature.dependencies ?? []) {
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

  private makeResolvedDependencies(
    state: CliState,
    feature: Pick<FeatureDeclaration, 'dependencies'>,
    overrides: ReadonlyMap<string, InstalledDependency> = new Map(),
  ): Map<string, InstalledDependency> {
    const resolvedDependencies = new Map<string, InstalledDependency>();
    for (const dependency of feature.dependencies ?? []) {
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
