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

import { isDeepStrictEqual } from 'node:util';

import type {
  CliState,
  InstalledIntegration,
  InstalledIntegrationFeature,
} from '@/core/state/state.ts';
import { updateState } from '@/core/state/state-repository.ts';

function sameFeature(
  left: InstalledIntegrationFeature,
  right: InstalledIntegrationFeature,
): boolean {
  return (
    left.featureId === right.featureId &&
    left.scope === right.scope &&
    left.targetRoot === right.targetRoot
  );
}

function findFeature(
  integration: InstalledIntegration | undefined,
  feature: InstalledIntegrationFeature,
): InstalledIntegrationFeature | undefined {
  return integration?.features.find((entry) => sameFeature(entry, feature));
}

interface IntegrationChange {
  integrationId: string;
  desired?: InstalledIntegration;
  removed: InstalledIntegrationFeature[];
  updated: InstalledIntegrationFeature[];
}

function collectChanges(before: CliState, changed: CliState): IntegrationChange[] {
  const priorIntegrations = before.integrations.installed;
  const changedIntegrations = changed.integrations.installed;
  const integrationIds = new Set([
    ...priorIntegrations.map((entry) => entry.integrationId),
    ...changedIntegrations.map((entry) => entry.integrationId),
  ]);

  return [...integrationIds].flatMap((integrationId) => {
    const prior = priorIntegrations.find((entry) => entry.integrationId === integrationId);
    const desired = changedIntegrations.find((entry) => entry.integrationId === integrationId);
    const removed = prior?.features.filter((feature) => !findFeature(desired, feature)) ?? [];
    const updated =
      desired?.features.filter(
        (feature) => !isDeepStrictEqual(findFeature(prior, feature), feature),
      ) ?? [];
    return removed.length + updated.length > 0
      ? [{ integrationId, desired, removed, updated }]
      : [];
  });
}

function applyChange(latest: CliState, change: IntegrationChange): void {
  let current = latest.integrations.installed.find(
    (entry) => entry.integrationId === change.integrationId,
  );
  if (current) {
    current.features = current.features.filter(
      (feature) => !change.removed.some((entry) => sameFeature(entry, feature)),
    );
  } else if (change.desired && change.updated.length > 0) {
    current = { ...change.desired, features: [] };
    latest.integrations.installed.push(current);
  }
  if (!current) {
    return;
  }

  for (const feature of change.updated) {
    const index = current.features.findIndex((entry) => sameFeature(entry, feature));
    if (index < 0) {
      current.features.push(feature);
    } else {
      current.features[index] = feature;
    }
  }
  if (change.desired) {
    current.updatedAt = change.desired.updatedAt;
    current.updatedByCliVersion = change.desired.updatedByCliVersion;
  }
  if (current.features.length === 0) {
    latest.integrations.installed = latest.integrations.installed.filter(
      (entry) => entry !== current,
    );
  }
}

/** Apply recorded feature changes after slow installation work, using the latest state. */
export function persistIntegrationChanges(before: CliState, changed: CliState): void {
  const changes = collectChanges(before, changed);
  if (changes.length === 0) {
    return;
  }
  updateState((latest) => {
    for (const change of changes) {
      applyChange(latest, change);
    }
  });
}
