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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { NetworkConfigError } from '@/core/errors.ts';
import logger from '@/core/observability/logger.ts';
import { buildRequest, fetchAuthenticated } from '@/core/server/fetch.ts';
import { getActiveConnection, tryLoadState } from '@/core/state/state-manager.ts';
import {
  activeConnectionForIdentitySeed,
  identityFromConnection,
  isIdentityCompleteForConnection,
  needsIdentityEnrichment,
  resolveTelemetryIdentity,
} from '@/core/telemetry/identity-fetch.ts';

import { readFreshFlagDecisions, writeFlagDecisions } from './cache.ts';
import { LAUNCHDARKLY_INIT_TIMEOUT_SECONDS, resolveLaunchDarklyClientSideId } from './constants.ts';
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
      ...(identity.enterpriseUuid ? { enterprise: { key: identity.enterpriseUuid } } : {}),
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

function toBooleanFlagMap(allFlags: unknown): Record<string, boolean> {
  if (!allFlags || typeof allFlags !== 'object' || Array.isArray(allFlags)) {
    throw new CommandFailedError('LaunchDarkly returned an invalid flag response');
  }
  const decisions: Record<string, boolean> = {};
  for (const [key, flag] of Object.entries(allFlags as Record<string, unknown>)) {
    if (!flag || typeof flag !== 'object' || !('value' in flag)) {
      throw new CommandFailedError('LaunchDarkly returned an invalid flag evaluation');
    }
    Object.defineProperty(decisions, key, { value: flag.value === true, enumerable: true });
  }
  return decisions;
}

/** Returns null on refresh failure so callers do not cache failed evaluations. */
export const fetchFlagsFromLaunchDarkly: FeatureFlagFetcher = async (identity) => {
  const clientSideId = resolveLaunchDarklyClientSideId();
  const context = buildLaunchDarklyContext(identity);
  if (!clientSideId || !context) {
    return null;
  }

  const encodedContext = Buffer.from(JSON.stringify(context)).toString('base64url');
  const url = `https://clientsdk.launchdarkly.com/sdk/evalx/${encodeURIComponent(clientSideId)}/contexts/${encodedContext}`;
  try {
    const response = await fetchAuthenticated(
      url,
      buildRequest(
        'GET',
        { Accept: 'application/json' },
        LAUNCHDARKLY_INIT_TIMEOUT_SECONDS * 1000,
        undefined,
      ),
    );
    if (!response.ok) {
      throw new CommandFailedError(`LaunchDarkly flag refresh returned HTTP ${response.status}`);
    }
    return toBooleanFlagMap(await response.json());
  } catch (err) {
    const message = `LaunchDarkly flag refresh failed: ${(err as Error).message}`;
    if (err instanceof NetworkConfigError) {
      logger.warn(message);
    } else {
      logger.debug(message);
    }
    return null;
  }
};

async function resolveFeatureFlagIdentity(auth: ResolvedAuth): Promise<FeatureFlagIdentity | null> {
  const state = tryLoadState();
  const active = state ? getActiveConnection(state) : undefined;
  const conn = activeConnectionForIdentitySeed(auth, active);

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
    enterpriseUuid: identity.enterprise_uuid ?? null,
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
 * callers treat missing keys as false. Uses a 2-hour local cache under
 * `~/.sonar/sonarqube-cli/launch-darkly/`. Fetch failures are not written to
 * the cache so a transient LaunchDarkly outage cannot lock users out for the TTL.
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

    const fetched = await fetchFlags(identity);
    if (fetched === null) {
      return {};
    }

    const decisions = selectFlagDecisions(fetched, flagKeys);
    writeFlagDecisions(identity, decisions, clientSideId, nowMs);
    return decisions;
  } catch (err) {
    logger.debug(`Private Beta flag resolution failed: ${(err as Error).message}`);
    return {};
  }
}
