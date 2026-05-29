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
  IntegrationScope,
  IntegrationStateAttribute,
} from '../../../../../lib/state';
import type { DependencyDeclaration } from './dependencies';
import type { ResourceDeclaration } from './resources';

export type MaybePromise<T> = T | Promise<T>;

export interface IntegrationContext {
  state: CliState;
  targetRoot: string;
  scope: IntegrationScope;
  force?: boolean;
  attrs?: Record<string, IntegrationStateAttribute>;
}

export interface IntegrationInvocation<TOptions = Record<string, unknown>> {
  options: TOptions;
  targetRoot: string;
  scope: IntegrationScope;
  force?: boolean;
  attrs?: Record<string, IntegrationStateAttribute>;
  nonInteractive?: boolean;
}

export type WhenResult = { kind: 'ask'; question?: string } | { kind: 'skip'; reason?: string };

export interface FeatureWhenContext<TOptions = Record<string, unknown>> {
  options: TOptions;
  scope: IntegrationScope;
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
}

export interface FeatureDeclaration<TOptions = Record<string, unknown>> {
  id: string;
  displayName: string;
  /** Appended in parens to the default prompt. Ignored if `when` returns a custom question. */
  hint?: string;
  /** Skip the feature with a reason or ask to install it. Defaults to ask. */
  when?: (ctx: FeatureWhenContext<TOptions>) => MaybePromise<WhenResult>;
  targetRoot?: FeatureTargetRoot<TOptions>;
  scope?: FeatureScope<TOptions>;
  dependencies?: DependencyDeclaration[];
  resources?: ResourceDeclaration[];
  operations?: FeatureOperation[];
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

export interface AppliedResource {
  id: string;
  resourceType: string;
  version?: string;
  path?: string;
}
