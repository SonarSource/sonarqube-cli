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

import type { IntegrationScope } from '@/core/state/state.ts';

import type { FeatureApplication, FeatureDeclaration, IntegrationInvocation } from './types.ts';

/**
 * Resolve every feature into a {@link FeatureApplication} for the invocation,
 * pairing the declaration with its resolved target root and scope plus the
 * invocation's auth/force/attrs.
 */
export async function buildApplications<TOptions>(
  invocation: IntegrationInvocation<TOptions>,
  features: FeatureDeclaration<TOptions>[],
): Promise<FeatureApplication<TOptions>[]> {
  const applications: FeatureApplication<TOptions>[] = [];
  for (const feature of features) {
    applications.push({
      feature,
      targetRoot: await resolveFeatureTargetRoot(invocation, feature),
      scope: await resolveFeatureScope(invocation, feature),
      auth: invocation.auth,
      force: invocation.force,
      attrs: invocation.attrs,
    });
  }
  return applications;
}

/**
 * Resolve the target root a feature applies to for the given invocation. A
 * feature may pin a fixed root, derive one from the invocation, or fall back to
 * the invocation's default root.
 */
export async function resolveFeatureTargetRoot<TOptions>(
  invocation: IntegrationInvocation<TOptions>,
  feature: FeatureDeclaration<TOptions>,
): Promise<string> {
  const { targetRoot } = feature;
  if (typeof targetRoot === 'function') {
    return targetRoot(invocation);
  }
  return targetRoot ?? invocation.targetRoot;
}

/**
 * Resolve the scope a feature installs at for the given invocation. A feature
 * may pin a fixed scope, derive one from the invocation, or fall back to the
 * invocation's default scope.
 */
export async function resolveFeatureScope<TOptions>(
  invocation: IntegrationInvocation<TOptions>,
  feature: FeatureDeclaration<TOptions>,
): Promise<IntegrationScope> {
  const { scope } = feature;
  if (typeof scope === 'function') {
    return scope(invocation);
  }
  return scope ?? invocation.scope;
}
