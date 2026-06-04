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

// Shared helpers for asserting on declarative integration state written to
// state.json by `sonar integrate <agent>`. Used by the codex, copilot, and
// claude integration specs.

import type { TestHarness } from '../../harness';

export interface InstalledIntegrationFeature {
  featureId: string;
  scope: string;
  targetRoot?: string;
  dependencies?: Array<{ id: string }>;
  attrs?: Record<string, unknown>;
}

export interface InstalledIntegration {
  integrationId: string;
  features: InstalledIntegrationFeature[];
}

/** Returns the persisted declarative integration entry, or `undefined` if absent. */
export function getInstalledIntegration(
  harness: TestHarness,
  integrationId: string,
): InstalledIntegration | undefined {
  const state = harness.stateJsonFile.asJson();
  return (state.integrations?.installed ?? []).find(
    (integration: { integrationId?: string }) => integration.integrationId === integrationId,
  ) as InstalledIntegration | undefined;
}

/** Finds a feature in declarative integration state, or `undefined` if absent. */
export function findInstalledFeature(
  harness: TestHarness,
  integrationId: string,
  featureId: string,
  scope?: string,
): InstalledIntegrationFeature | undefined {
  return getInstalledIntegration(harness, integrationId)?.features.find(
    (feature) =>
      feature.featureId === featureId && (scope === undefined || feature.scope === scope),
  );
}
