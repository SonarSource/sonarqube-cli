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

import { findInstalledFeature } from './installation-recorder.ts';
import type {
  FeatureApplication,
  FeatureAvailability,
  FeatureDeclaration,
  IntegrationDeclaration,
  IntegrationInvocation,
  SubfeatureApplication,
  SubfeatureDeclaration,
} from './types.ts';
import { isFeatureContainer } from './types.ts';

/**
 * Resolve every feature into a {@link FeatureApplication} for the invocation,
 * pairing the declaration with its resolved target root and scope, the
 * invocation's auth/force/attrs, recorded install state and availability.
 */
export async function buildApplications<TOptions>(
  invocation: IntegrationInvocation<TOptions>,
  integration: IntegrationDeclaration<TOptions>,
  excludedFeatureIds: readonly string[] = [],
): Promise<FeatureApplication<TOptions>[]> {
  const applications: FeatureApplication<TOptions>[] = [];
  for (const feature of integration.features) {
    if (excludedFeatureIds.includes(feature.id)) {
      continue;
    }
    const targetRoot = await resolveFeatureTargetRoot(invocation, feature);
    const scope = await resolveFeatureScope(invocation, feature);
    const installedFeature = findInstalledFeature(
      invocation.state,
      { scope, targetRoot },
      integration,
      feature,
    );
    const { available, unavailableReason } = await checkAvailability(invocation, feature);
    applications.push({
      feature,
      targetRoot,
      scope,
      auth: invocation.auth,
      force: invocation.force,
      attrs: invocation.attrs,
      installed: installedFeature !== undefined,
      available,
      unavailableReason,
      subfeatureApplications: isFeatureContainer(feature)
        ? await buildSubfeatureApplications(
            invocation,
            feature.subfeatures,
            available,
            installedFeature?.subfeatures?.map((recorded) => recorded.featureId) ?? [],
          )
        : [],
    });
  }
  return applications;
}

async function buildSubfeatureApplications<TOptions>(
  invocation: IntegrationInvocation<TOptions>,
  subfeatures: SubfeatureDeclaration<TOptions>[],
  containerAvailable: boolean | undefined,
  recordedIds: readonly string[],
): Promise<SubfeatureApplication<TOptions>[]> {
  const applications: SubfeatureApplication<TOptions>[] = [];
  for (const subfeature of subfeatures) {
    // Not checked while the container is unavailable or unknown: it cannot install them.
    const { available, unavailableReason } =
      containerAvailable === true
        ? await checkAvailability(invocation, subfeature)
        : { available: undefined, unavailableReason: undefined };
    applications.push({
      subfeature,
      installed: recordedIds.includes(subfeature.id),
      available,
      unavailableReason,
      active: false,
    });
  }
  return applications;
}

async function checkAvailability<TOptions>(
  invocation: IntegrationInvocation<TOptions>,
  declaration: Pick<FeatureDeclaration<TOptions>, 'isAvailable'>,
): Promise<FeatureAvailability> {
  return (await declaration.isAvailable?.(invocation)) ?? { available: true };
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
