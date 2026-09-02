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

// Derives targetRoot/repoRoot -> SonarQube project/server mappings live from every
// currently project-scoped `integrations.installed` feature, for discoverProject()'s
// known-mapping source. targetRoot/repoRoot are copied verbatim from the feature's
// attrs (never collapsed into one value) so worktree-aware matching can prefer the
// precise location over the worktree-wide fallback — see `resolveLookupPaths` /
// `selectFeatureForLookupPaths`.

import { pathComparisonKey } from '@/core/io/fs-utils.ts';
import type {
  CliState,
  InstalledIntegrationFeature,
  IntegrationStateAttribute,
} from '@/core/state/state.ts';
import { parseTimestampMillis } from '@/core/time/timestamp.ts';

/**
 * A folder known to be bound to a SonarQube project, derived from a project-scoped
 * integration feature's attrs. Keeps `targetRoot`/`repoRoot` as two distinct signals
 * (never collapsed into one) so worktree-aware matching can prefer the precise
 * physical location over a worktree-wide fallback — see `resolveLookupPaths` /
 * `selectFeatureForLookupPaths`.
 */
export interface KnownServerProjectMapping {
  /** Physical location this was recorded from — the precise, most-specific signal. */
  targetRoot: string;
  /** Repository's main working tree root, when known — the worktree-wide fallback signal. */
  repoRoot?: string;
  /** SonarQube project key bound to this mapping. */
  projectKey: string;
  /**
   * Server URL for this binding, when the feature actually recorded one (Vortex-entitled
   * agent integrations). Left undefined when it didn't (e.g. `git` integrate never records a
   * connection) — deliberately NOT backfilled here from whichever connection happened to be
   * active at derive time, since that is a point-in-time snapshot that can go stale (e.g.
   * env-var auth switching server/org per invocation). Callers matching this mapping
   * substitute the connection active *at match time* instead — see `discoverProject()`.
   */
  serverUrl?: string;
  /** Organization key (SonarQube Cloud only), same recorded-only precedence as `serverUrl`. */
  orgKey?: string;
  /** ISO timestamp of the contributing feature's last update; used to resolve conflicts when merging. */
  updatedAt: string;
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
    updatedAt: feature.updatedAt,
  };
}

/**
 * Derives targetRoot/repoRoot -> project mappings by parsing `attrs.projectKey`/`serverUrl`/
 * `orgKey` off every currently project-scoped `integrations.installed` feature, for
 * `discoverProject()`'s known-mapping source.
 */
export function buildKnownServerProjectMappings(state: CliState): KnownServerProjectMapping[] {
  const byTargetRoot = new Map<string, KnownServerProjectMapping>();

  for (const integration of state.integrations.installed) {
    for (const feature of integration.features) {
      const mapping = deriveMappingForFeature(feature);
      if (!mapping) {
        continue;
      }

      const key = pathComparisonKey(mapping.targetRoot);
      const existing = byTargetRoot.get(key);
      if (
        existing &&
        parseTimestampMillis(existing.updatedAt) >= parseTimestampMillis(mapping.updatedAt)
      ) {
        continue;
      }

      byTargetRoot.set(key, mapping);
    }
  }

  return [...byTargetRoot.values()];
}
