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
  InstalledIntegrationFeature,
  InstalledIntegrationOperation,
  InstalledIntegrationResource,
} from '../../../../../lib/state';
import type { ResourceDeclaration } from './resources';
import type {
  AppliedFeature,
  AppliedOperation,
  AppliedResource,
  FeatureDeclaration,
  FeatureOperation,
  IntegrationContext,
  IntegrationDeclaration,
  IntegrationInvocation,
} from './types';

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
    feature: FeatureDeclaration<TOptions>,
  ): Promise<AppliedFeature> {
    const resources: AppliedResource[] = [];
    const operations: AppliedOperation[] = [];

    for (const resource of feature.resources ?? []) {
      resources.push(await resource.apply(context));
    }

    for (const operation of feature.operations ?? []) {
      if (operation.shouldApply && !(await operation.shouldApply(context))) {
        continue;
      }
      await operation.apply(context);
      operations.push({ id: operation.id, version: operation.version });
    }

    return { resources, operations };
  }

  async applyAndRecordFeature<TOptions>(
    context: IntegrationContext,
    integration: IntegrationDeclaration<TOptions>,
    feature: FeatureDeclaration<TOptions>,
  ): Promise<InstalledIntegrationFeature> {
    const applied = await this.applyFeature(context, feature);
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
      resources: this.upsertResources(existing?.resources ?? [], applied.resources, now),
      operations: this.upsertOperations(existing?.operations ?? [], applied.operations, now),
      attrs: context.attrs,
    };

    if (existing) {
      Object.assign(existing, next);
      return existing;
    }

    installedIntegration.features.push(next);
    return next;
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

  private upsertResources(
    existing: InstalledIntegrationResource[],
    applied: AppliedResource[],
    now: string,
  ): InstalledIntegrationResource[] {
    const resources = [...existing];
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
  ): InstalledIntegrationOperation[] {
    const operations = [...existing];
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
}

export const integrationInstaller = new IntegrationInstaller();
