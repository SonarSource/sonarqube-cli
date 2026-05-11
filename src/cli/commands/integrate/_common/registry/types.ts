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
}

export interface IntegrationDeclaration<TOptions = Record<string, unknown>> {
  id: string;
  displayName: string;
  features: FeatureDeclaration<TOptions>[];
  legacyFeatures?: LegacyFeatureDeclaration[];
}

export interface FeatureDeclaration<TOptions = Record<string, unknown>> {
  id: string;
  displayName: string;
  when?: (invocation: IntegrationInvocation<TOptions>) => boolean;
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
  resources: AppliedResource[];
  operations: AppliedOperation[];
}

export interface AppliedResource {
  id: string;
  resourceType: string;
  version?: string;
  path?: string;
}
