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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { CliState, IntegrationScope, IntegrationStateAttribute } from '@/core/state/state.ts';
import type { Console } from '@/core/ui/console.ts';

import type { DependencyDeclaration } from '../dependencies';
import type { RemovableResource, ResourceDeclaration, ResourceIdentity } from '../resources';
import type { InstallDecision } from './selection.ts';

export type MaybePromise<T> = T | Promise<T>;
export type IntegrationExecutionMode = 'install' | 'update';

export interface IntegrationContext {
  state: CliState;
  targetRoot: string;
  scope: IntegrationScope;
  executionMode: IntegrationExecutionMode;
  console: Console;
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
  string | ((invocation: IntegrationInvocation<TOptions>) => MaybePromise<string>);

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
  /** Ids of features offered (`ask`) and deliberately declined; feeds telemetry's `features_declined`. */
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
  /**
   * Ids of retired features of the same integration that this feature supersedes.
   * Post-update migrates each recorded predecessor install into this feature.
   */
  replacedIds?: string[];
  legacyCleanups?: (ResourceIdentity & RemovableResource)[];
  /**
   * Optional "try it out" example rendered by the framework completion summary
   * when this feature is installed.
   */
  postInstallExample?: PostInstallExample;
}

/**
 * Subfeature declaration — metadata, install condition, and the dependencies,
 * resources, and operations owned by that subfeature. Scope, target root, and
 * attrs always come from the owning {@link FeatureContainer}.
 */
export type SubfeatureDeclaration<TOptions = Record<string, unknown>> = Pick<
  FeatureDeclaration<TOptions>,
  'id' | 'displayName' | 'shouldInstall' | 'dependencies' | 'resources' | 'operations'
> & {
  /** Gates inclusion in `defaultInstallSubfeatureIds` during reconcile migration, where `shouldInstall`'s `options` don't exist yet. Defaults to eligible. */
  migrationEligible?: (attrs: Record<string, IntegrationStateAttribute> | undefined) => boolean;
};

/**
 * A {@link FeatureDeclaration} that groups {@link SubfeatureDeclaration}s under it.
 * Container-owned assets always apply; subfeature-owned assets apply only while
 * that subfeature is active.
 * Use {@link isFeatureContainer} to downcast before accessing `subfeatures`.
 */
export interface FeatureContainer<
  TOptions = Record<string, unknown>,
> extends FeatureDeclaration<TOptions> {
  subfeatures: SubfeatureDeclaration<TOptions>[];
  defaultInstallSubfeatureIds: string[];
}

/** Type guard — returns true when `feature` is a {@link FeatureContainer}. */
export function isFeatureContainer<TOptions>(
  feature: FeatureDeclaration<TOptions>,
): feature is FeatureContainer<TOptions> {
  return 'subfeatures' in feature;
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
