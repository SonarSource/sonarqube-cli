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

import type { LDContext } from 'launchdarkly-node-client-sdk';
import { initialize } from 'launchdarkly-node-client-sdk';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import logger from '@/core/observability/logger.ts';
import {
  authMatchesConnection,
  getActiveConnection,
  tryLoadState,
} from '@/core/state/state-manager.ts';
import {
  identityFromConnection,
  isIdentityCompleteForConnection,
  needsIdentityEnrichment,
  resolveTelemetryIdentity,
} from '@/core/telemetry/identity-fetch.ts';

import { readFreshFlagDecisions, writeFlagDecisions } from './cache.ts';
import {
  getLaunchDarklyDir,
  LAUNCHDARKLY_INIT_TIMEOUT_SECONDS,
  resolveLaunchDarklyClientSideId,
} from './constants.ts';
import type { FeatureFlagFetcher, FeatureFlagIdentity } from './types.ts';

export type { LaunchDarklyEnvironment } from './constants.ts';
export {
  ENV_LAUNCHDARKLY_ENVIRONMENT,
  FEATURE_FLAG_CACHE_TTL_MS,
  getLaunchDarklyDir,
  LAUNCHDARKLY_CLIENT_SIDE_IDS,
  LAUNCHDARKLY_PROJECT_KEY,
  resolveLaunchDarklyClientSideId,
  resolveLaunchDarklyEnvironment,
} from './constants.ts';
export type { FeatureFlagFetcher, FeatureFlagIdentity } from './types.ts';

export interface ResolvePrivateBetaFlagsOptions {
  fetchFlags?: FeatureFlagFetcher;
  /** Required Private Beta flag keys discovered from the command tree. */
  flagKeys?: readonly string[];
  nowMs?: number;
  clientSideId?: string;
}

export function buildLaunchDarklyContext(identity: FeatureFlagIdentity): LDContext | null {
  if (identity.connectionType === 'cloud') {
    if (!identity.userUuid || !identity.organizationUuidV4) {
      return null;
    }
    return {
      kind: 'multi',
      user: { key: identity.userUuid },
      organization: { key: identity.organizationUuidV4 },
    };
  }

  if (!identity.sqsInstallationId) {
    return null;
  }

  if (identity.userUuid) {
    return {
      kind: 'multi',
      installation: { key: identity.sqsInstallationId },
      user: { key: identity.userUuid },
    };
  }

  return {
    kind: 'installation',
    key: identity.sqsInstallationId,
  };
}

function toBooleanFlagMap(allFlags: Record<string, unknown>): Record<string, boolean> {
  const decisions: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(allFlags)) {
    decisions[key] = value === true;
  }
  return decisions;
}

/**
 * Fetches Private Beta flag values via the LaunchDarkly client-side SDK.
 * Failures and missing client-side IDs yield an empty map (all flags treated as false).
 */
export const fetchFlagsFromLaunchDarkly: FeatureFlagFetcher = async (identity) => {
  const clientSideId = resolveLaunchDarklyClientSideId();
  if (!clientSideId) {
    return {};
  }

  const context = buildLaunchDarklyContext(identity);
  if (!context) {
    return {};
  }

  const client = initialize(clientSideId, context, {
    streaming: false,
    sendEventsOnlyForVariation: true,
    localStoragePath: getLaunchDarklyDir(),
    logger: {
      debug: (message) => {
        logger.debug(message);
      },
      info: (message) => {
        logger.debug(message);
      },
      warn: (message) => {
        logger.debug(message);
      },
      error: (message) => {
        logger.debug(message);
      },
    },
  });

  try {
    await client.waitForInitialization(LAUNCHDARKLY_INIT_TIMEOUT_SECONDS);
    return toBooleanFlagMap(client.allFlags());
  } catch (err) {
    logger.debug(`LaunchDarkly flag refresh failed: ${(err as Error).message}`);
    return {};
  } finally {
    await client.close().catch(() => undefined);
  }
};

async function resolveFeatureFlagIdentity(auth: ResolvedAuth): Promise<FeatureFlagIdentity | null> {
  const state = tryLoadState();
  const active = state ? getActiveConnection(state) : undefined;
  const conn = active && authMatchesConnection(auth, active) ? active : undefined;

  let identity = identityFromConnection(conn);
  if (needsIdentityEnrichment(identity, auth.connectionType, conn)) {
    identity = await resolveTelemetryIdentity(auth, identity);
  }

  if (!isIdentityCompleteForConnection(identity, auth.connectionType)) {
    return null;
  }

  return {
    connectionType: auth.connectionType,
    userUuid: identity.user_uuid,
    organizationUuidV4: identity.organization_uuid_v4,
    sqsInstallationId: identity.sqs_installation_id,
  };
}

function selectFlagDecisions(
  allFlags: Record<string, boolean>,
  flagKeys: readonly string[],
): Record<string, boolean> {
  const decisions: Record<string, boolean> = {};
  for (const key of flagKeys) {
    // Missing keys are undefined at runtime despite Record<string, boolean>.
    decisions[key] = allFlags[key] ?? false;
  }
  return decisions;
}

/**
 * Resolves Private Beta LaunchDarkly flag values for the current identity.
 *
 * Returns an empty map when there are no declared flag keys, auth is missing,
 * identity is incomplete, the client-side ID is missing, or the fetch fails —
 * callers treat missing keys as false. Uses a 12-hour local cache under
 * `~/.sonar/sonarqube-cli/launch-darkly/`.
 */
export async function resolvePrivateBetaFlags(
  auth: ResolvedAuth | null,
  options: ResolvePrivateBetaFlagsOptions = {},
): Promise<Record<string, boolean>> {
  const flagKeys = options.flagKeys ?? [];
  if (!auth || flagKeys.length === 0) {
    return {};
  }

  const clientSideId = options.clientSideId ?? resolveLaunchDarklyClientSideId();
  if (!clientSideId) {
    return {};
  }

  const nowMs = options.nowMs ?? Date.now();
  const fetchFlags = options.fetchFlags ?? fetchFlagsFromLaunchDarkly;

  try {
    const identity = await resolveFeatureFlagIdentity(auth);
    if (!identity) {
      return {};
    }

    const cached = readFreshFlagDecisions(identity, flagKeys, clientSideId, nowMs);
    if (cached) {
      return cached;
    }

    const decisions = selectFlagDecisions(await fetchFlags(identity), flagKeys);
    writeFlagDecisions(identity, decisions, clientSideId, nowMs);
    return decisions;
  } catch (err) {
    logger.debug(`Private Beta flag resolution failed: ${(err as Error).message}`);
    return {};
  }
}
