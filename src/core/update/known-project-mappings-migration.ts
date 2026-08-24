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

// Derives folder -> SonarQube project key mappings from project-scoped integration
// feature attrs, consumed by the post-update mechanism that runs automatically
// after CLI upgrades. Must run before `migrateDeclarativeIntegrations` (see
// post-update.ts): once integrations move to global scope they stop carrying
// per-folder `projectKey`/`repoRoot` attrs, so this is the last point where that
// data is still readable from the pre-reconciliation feature set.

import { resolveRecordedRepoRoot } from '@/core/host/git/worktree.ts';
import { pathComparisonKey } from '@/core/io/fs-utils.ts';
import type {
  AuthConnection,
  CliState,
  InstalledIntegrationFeature,
  IntegrationStateAttribute,
  KnownServerProjectMapping,
} from '@/core/state/state.ts';
import { getActiveConnection } from '@/core/state/state-manager.ts';
import { loadState, saveState } from '@/core/state/state-repository.ts';

function getOptionalStringAttr(
  attrs: Record<string, IntegrationStateAttribute> | undefined,
  key: string,
): string | undefined {
  const value = attrs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function updatedAtMillis(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function resolveFolderForFeature(feature: InstalledIntegrationFeature): Promise<string> {
  const recordedRepoRoot = getOptionalStringAttr(feature.attrs, 'repoRoot');
  return resolveRecordedRepoRoot(recordedRepoRoot ?? feature.targetRoot);
}

function resolveConnectionForFeature(
  feature: InstalledIntegrationFeature,
  activeConnection: AuthConnection | undefined,
): { serverUrl: string | undefined; orgKey: string | undefined } {
  return {
    serverUrl: getOptionalStringAttr(feature.attrs, 'serverUrl') ?? activeConnection?.serverUrl,
    orgKey: getOptionalStringAttr(feature.attrs, 'orgKey') ?? activeConnection?.orgKey,
  };
}

async function deriveMappingForFeature(
  feature: InstalledIntegrationFeature,
  activeConnection: AuthConnection | undefined,
): Promise<KnownServerProjectMapping | undefined> {
  if (feature.scope !== 'project') {
    return undefined;
  }

  const projectKey = getOptionalStringAttr(feature.attrs, 'projectKey');
  if (!projectKey) {
    return undefined;
  }

  const { serverUrl, orgKey } = resolveConnectionForFeature(feature, activeConnection);
  if (!serverUrl) {
    return undefined;
  }

  const folder = await resolveFolderForFeature(feature);
  return { folder, projectKey, serverUrl, orgKey, updatedAt: feature.updatedAt };
}

export async function buildKnownServerProjectMappings(
  state: CliState,
): Promise<KnownServerProjectMapping[]> {
  const byFolder = new Map<string, KnownServerProjectMapping>();
  const activeConnection = getActiveConnection(state);

  for (const integration of state.integrations.installed) {
    for (const feature of integration.features) {
      const mapping = await deriveMappingForFeature(feature, activeConnection);
      if (!mapping) {
        continue;
      }

      const key = pathComparisonKey(mapping.folder);
      const existing = byFolder.get(key);
      if (existing && updatedAtMillis(existing.updatedAt) >= updatedAtMillis(mapping.updatedAt)) {
        continue;
      }

      byFolder.set(key, mapping);
    }
  }

  return [...byFolder.values()];
}

export function mergeKnownServerProjectMappings(
  existing: KnownServerProjectMapping[],
  discovered: KnownServerProjectMapping[],
): KnownServerProjectMapping[] {
  const byFolder = new Map(existing.map((mapping) => [pathComparisonKey(mapping.folder), mapping]));

  for (const mapping of discovered) {
    const key = pathComparisonKey(mapping.folder);
    const current = byFolder.get(key);
    if (!current || updatedAtMillis(mapping.updatedAt) > updatedAtMillis(current.updatedAt)) {
      byFolder.set(key, mapping);
    }
  }

  return [...byFolder.values()];
}

export async function migrateKnownServerKeyMappingsForProjectLevelFeatures(): Promise<void> {
  const state = loadState();
  const discovered = await buildKnownServerProjectMappings(state);
  if (discovered.length === 0) {
    return;
  }

  state.knownServerProjectMappings = mergeKnownServerProjectMappings(
    state.knownServerProjectMappings ?? [],
    discovered,
  );
  saveState(state);
}
