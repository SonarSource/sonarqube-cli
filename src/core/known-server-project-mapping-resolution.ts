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

// Match-time resolution of the known-server-project-mapping source; table construction lives in known-server-project-mappings.ts.

import { isValidServerUrl, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { LookupPath } from '@/core/host/git/lookup-path-resolver.ts';
import {
  type FeatureMatch,
  type RecordedFeatureCandidate,
  selectFeatureForLookupPaths,
} from '@/core/host/recorded-feature-resolver.ts';
import {
  buildKnownServerProjectMappings,
  mergeKnownServerProjectMappings,
} from '@/core/known-server-project-mappings.ts';
import logger from '@/core/observability/logger.ts';
import { formatConfigFields } from '@/core/project-discovery-format.ts';
import type { DiscoveredProject, DiscoverProjectOptions } from '@/core/project-info.ts';
import type { CliState, KnownServerProjectMapping } from '@/core/state/state.ts';
import { getActiveConnection } from '@/core/state/state-manager.ts';
import { loadState } from '@/core/state/state-repository.ts';

export const KNOWN_SERVER_PROJECT_MAPPING_SOURCE = 'known project mapping';

export interface KnownMappingsResult {
  state: CliState;
  mappings: KnownServerProjectMapping[];
}

/** Loaded upfront so `discoverProjects()` can derive knownRoots and share one lookupPaths list. */
export function loadKnownMappings(): KnownMappingsResult | undefined {
  try {
    const state = loadState();
    const mappings = mergeKnownServerProjectMappings(
      state.knownServerProjectMappings ?? [],
      buildKnownServerProjectMappings(state),
    );
    return { state, mappings };
  } catch (error) {
    logger.debug(`Known project mapping lookup skipped: ${(error as Error).message}`);
    return undefined;
  }
}

/** Passed raw to resolveLookupPaths() — it picks the shallowest matching one itself. */
export function collectKnownRoots(known: KnownMappingsResult | undefined): string[] {
  return (known?.mappings ?? []).flatMap((mapping) =>
    mapping.repoRoot ? [mapping.targetRoot, mapping.repoRoot] : [mapping.targetRoot],
  );
}

function matchKnownServerProjectMapping(
  lookupPaths: LookupPath[],
  mappings: KnownServerProjectMapping[],
): FeatureMatch<KnownServerProjectMapping> | undefined {
  if (mappings.length === 0) {
    return undefined;
  }

  const candidates: RecordedFeatureCandidate<KnownServerProjectMapping>[] = mappings.map(
    (mapping) => ({
      feature: mapping,
      targetRoot: mapping.targetRoot,
      repoRoot: mapping.repoRoot,
    }),
  );

  return selectFeatureForLookupPaths(candidates, lookupPaths);
}

/** Prefers the caller's own resolved auth over state, so per-invocation env-var auth resolves correctly even if it hasn't been persisted yet. */
function resolveMappingConnection(
  mapping: KnownServerProjectMapping,
  state: CliState,
  auth?: ResolvedAuth | null,
): { serverUrl: string | undefined; orgKey: string | undefined } {
  if (mapping.serverUrl) {
    return { serverUrl: mapping.serverUrl, orgKey: mapping.orgKey };
  }
  if (auth) {
    return { serverUrl: auth.serverUrl, orgKey: auth.orgKey };
  }
  const activeConnection = getActiveConnection(state);
  return { serverUrl: activeConnection?.serverUrl, orgKey: activeConnection?.orgKey };
}

/** Matches against the combined persisted + live-derived mapping table, caller-loaded once above. */
export function applyKnownServerProjectMapping(
  config: DiscoveredProject,
  lookupPaths: LookupPath[],
  known: KnownMappingsResult,
  options: DiscoverProjectOptions,
): boolean {
  const match = matchKnownServerProjectMapping(lookupPaths, known.mappings);
  if (!match) {
    return false;
  }

  const { serverUrl, orgKey } = resolveMappingConnection(match.feature, known.state, options.auth);
  if (!serverUrl || !isValidServerUrl(serverUrl)) {
    return false;
  }

  config.configSources.push(KNOWN_SERVER_PROJECT_MAPPING_SOURCE);
  config.projectKey = match.feature.projectKey;
  config.serverUrl = serverUrl;
  config.organization = orgKey;
  config.projectRoot = match.matchedPath;
  config.integrationDir = match.feature.targetRoot;

  if (!options.silent) {
    const fields = formatConfigFields(config.serverUrl, config.projectKey, config.organization);
    if (fields) {
      options.console.print(`Found ${KNOWN_SERVER_PROJECT_MAPPING_SOURCE}: ${fields}`);
    }
  }

  return true;
}
