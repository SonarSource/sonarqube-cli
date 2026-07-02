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
  IntegrationScope,
  IntegrationStateAttribute,
} from '../../../../../lib/state';
import type { DependencyDeclaration } from './dependencies';
import type { RemovableResource, ResourceDeclaration, ResourceIdentity } from './resources';
import type { InstallDecision } from './selection';

export type MaybePromise<T> = T | Promise<T>;
export type IntegrationExecutionMode = 'install' | 'update';

export interface IntegrationContext {
  state: CliState;
  targetRoot: string;
  scope: IntegrationScope;
  executionMode: IntegrationExecutionMode;
  auth?: ResolvedAuth;
  force?: boolean;
  attrs?: Record<string, IntegrationStateAttribute>;
  resolvedDependencies: ReadonlyMap<string, InstalledDependency>;
}

export interface ContainerIntegrationContext extends IntegrationContext {
  activeSubfeatures: readonly SubfeatureDeclaration[];
}

export function isContainerIntegrationContext(
  ctx: IntegrationContext,
): ctx is ContainerIntegrationContext {
  return 'activeSubfeatures' in ctx;
}

export interface IntegrationInvocation<TOptions = Record<string, unknown>> {
  options: TOptions;
  targetRoot: string;
  scope: IntegrationScope;
  auth?: ResolvedAuth;
  force?: boolean;
  attrs?: Record<string, IntegrationStateAttribute>;
  nonInteractive?: boolean;
  state: CliState;
}

export type FeatureTargetRoot<TOptions = Record<string, unknown>> =
  | string
  | ((invocation: IntegrationInvocation<TOptions>) => MaybePromise<string>);

export type FeatureScope<TOptions = Record<string, unknown>> =
  | IntegrationScope
  | ((invocation: IntegrationInvocation<TOptions>) => MaybePromise<IntegrationScope>);

export interface IntegrationDeclaration<TOptions = Record<string, unknown>> {
  id: string;
  displayName: string;
  features: FeatureDeclaration<TOptions>[];
  legacyFeatures?: LegacyFeatureDeclaration[];
  combinedPostInstallExample?: (installedFeatureIds: string[]) => PostInstallExample | undefined;
}

export interface PostInstallExample {
  /** Boxed-note title. */
  title?: string;
  /** Info line printed above the box. */
  intro?: string;
  /** Box body lines. */
  lines: string[];
  /** Text line printed under the box. */
  footer?: string;
}

/**
 * A feature paired with its resolved per-invocation execution context (target
 * root, scope, auth, …).
 */
export interface FeatureApplication<TOptions = Record<string, unknown>> {
  feature: FeatureDeclaration<TOptions>;
  targetRoot: string;
  scope: IntegrationScope;
  auth?: ResolvedAuth;
  force?: boolean;
  attrs?: Record<string, IntegrationStateAttribute>;
}

export interface FeatureSelectionResult<TOptions = Record<string, unknown>> {
  toInstall: FeatureApplication<TOptions>[];
  toRemove: FeatureApplication<TOptions>[];
  /** Ids of features offered (`ask`) and deliberately declined; feeds telemetry's `features_skipped`. */
  declined: string[];
}

export type FeaturePreview = string | ((activeSubfeatureIds: readonly string[]) => string);

export interface FeatureDeclaration<TOptions = Record<string, unknown>> {
  id: string;
  displayName: string;
  benefitDescription?: string;
  previewDescription?: FeaturePreview;
  shouldInstall?: (
    invocation: IntegrationInvocation<TOptions>,
  ) => MaybePromise<boolean | InstallDecision>;
  targetRoot?: FeatureTargetRoot<TOptions>;
  scope?: FeatureScope<TOptions>;
  dependencies?: DependencyDeclaration[];
  resources?: ResourceDeclaration[];
  operations?: FeatureOperation[];
  legacyCleanups?: (ResourceIdentity & RemovableResource)[];
  /**
   * Optional "try it out" example rendered by the framework completion summary
   * when this feature is installed.
   */
  postInstallExample?: PostInstallExample;
}

/**
 * Thin subfeature declaration — metadata, install condition, and binary dependencies only.
 * No resources or operations; those belong to the owning {@link FeatureContainer}.
 */
export type SubfeatureDeclaration<TOptions = Record<string, unknown>> = Pick<
  FeatureDeclaration<TOptions>,
  'id' | 'displayName' | 'shouldInstall' | 'dependencies'
>;

/**
 * A {@link FeatureDeclaration} that groups thin {@link SubfeatureDeclaration}s under it.
 * The container owns the centralized resource; subfeatures contribute only binary
 * dependencies and install conditions (no resources, no operations).
 * Use {@link isFeatureContainer} from `selection` to downcast before accessing `subfeatures`.
 */
export interface FeatureContainer<
  TOptions = Record<string, unknown>,
> extends FeatureDeclaration<TOptions> {
  subfeatures: SubfeatureDeclaration<TOptions>[];
  defaultInstallSubfeatureIds: string[];
}

export interface LegacyFeatureDeclaration {
  id: string;
  removable: boolean;
}

export interface FeatureOperation {
  id: string;
  displayName?: string;
  version?: string;
  shouldApply?: (context: IntegrationContext) => MaybePromise<boolean>;
  apply: (context: IntegrationContext) => MaybePromise<void>;
  undo?: (context: IntegrationContext) => MaybePromise<void>;
}

export interface AppliedOperation {
  id: string;
  version?: string;
}

export interface AppliedFeature {
  dependencies: InstalledDependency[];
  resources: AppliedResource[];
  operations: AppliedOperation[];
}

export interface InstalledDependency {
  id: string;
  dependencyType: string;
  version?: string;
  path?: string;
}

export interface DependencyInstallContext extends IntegrationContext {
  existingDependency?: InstalledDependency;
}

export interface AppliedResource {
  id: string;
  resourceType: string;
  version?: string;
  path?: string;
}
