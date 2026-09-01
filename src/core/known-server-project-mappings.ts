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

// The targetRoot/repoRoot -> SonarQube project/server mapping table
// (`state.knownServerProjectMappings`) that `discoverProject()`'s fast path reads, kept
// current by the post-update migration and by discoverProject()'s own live fallback.
// targetRoot/repoRoot are copied verbatim from the feature's attrs (never collapsed into
// one value) so worktree-aware matching can prefer the precise location over the
// worktree-wide fallback — see `resolveLookupPaths` / `selectFeatureForLookupPaths`.

import { pathComparisonKey } from '@/core/io/fs-utils.ts';
import type {
  CliState,
  InstalledIntegrationFeature,
  IntegrationStateAttribute,
  KnownServerProjectMapping,
} from '@/core/state/state.ts';

/** True when `incoming` has server info that `current` lacks — the only case a duplicate gets replaced. */
function isMoreComplete(
  incoming: KnownServerProjectMapping,
  current: KnownServerProjectMapping,
): boolean {
  return incoming.serverUrl !== undefined && current.serverUrl === undefined;
}

/** Adds `mapping` into `mappings` in place; only collapses with an entry sharing both `targetRoot` and `projectKey` (a true duplicate) — a different `projectKey` at the same `targetRoot` is a conflict, kept as a separate candidate for `selectFeatureForLookupPaths` to resolve. */
function addMapping(
  mappings: KnownServerProjectMapping[],
  mapping: KnownServerProjectMapping,
): void {
  const duplicateIndex = mappings.findIndex(
    (entry) =>
      pathComparisonKey(entry.targetRoot) === pathComparisonKey(mapping.targetRoot) &&
      entry.projectKey === mapping.projectKey,
  );
  if (duplicateIndex === -1) {
    mappings.push(mapping);
    return;
  }

  if (isMoreComplete(mapping, mappings[duplicateIndex])) {
    mappings[duplicateIndex] = mapping;
  }
}

/** Merges `existing` into `discovered` (see `addMapping`); `discovered` stays first so it wins match-time ties on a shared `targetRoot`. */
export function mergeKnownServerProjectMappings(
  existing: KnownServerProjectMapping[],
  discovered: KnownServerProjectMapping[],
): KnownServerProjectMapping[] {
  const mappings = [...discovered];
  for (const mapping of existing) {
    addMapping(mappings, mapping);
  }

  return mappings;
}

function getOptionalStringAttr(
  attrs: Record<string, IntegrationStateAttribute> | undefined,
  key: string,
): string | undefined {
  const value = attrs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function deriveMappingForFeature(
  feature: InstalledIntegrationFeature,
): KnownServerProjectMapping | undefined {
  if (feature.scope !== 'project') {
    return undefined;
  }

  const projectKey = getOptionalStringAttr(feature.attrs, 'projectKey');
  if (!projectKey) {
    return undefined;
  }

  // serverUrl/orgKey are recorded-only — never backfilled from the active connection, which
  // would go stale by the time a future, possibly different-environment invocation matches
  // this mapping. Callers resolve the connection fresh at match time — see `discoverProject()`.
  return {
    targetRoot: feature.targetRoot,
    repoRoot: getOptionalStringAttr(feature.attrs, 'repoRoot'),
    projectKey,
    serverUrl: getOptionalStringAttr(feature.attrs, 'serverUrl'),
    orgKey: getOptionalStringAttr(feature.attrs, 'orgKey'),
  };
}

/**
 * Derives targetRoot/repoRoot -> project mappings by parsing `attrs.projectKey`/`serverUrl`/
 * `orgKey` off every currently project-scoped `integrations.installed` feature, for
 * `discoverProject()`'s known-mapping source.
 */
export function buildKnownServerProjectMappings(state: CliState): KnownServerProjectMapping[] {
  const mappings: KnownServerProjectMapping[] = [];

  for (const integration of state.integrations.installed) {
    for (const feature of integration.features) {
      const mapping = deriveMappingForFeature(feature);
      if (mapping) {
        addMapping(mappings, mapping);
      }
    }
  }

  return mappings;
}
