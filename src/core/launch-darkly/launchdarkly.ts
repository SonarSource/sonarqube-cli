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

import logger from '@/core/observability/logger.ts';

import {
  getLaunchDarklyDir,
  LAUNCHDARKLY_CLIENT_SIDE_ID,
  LAUNCHDARKLY_INIT_TIMEOUT_SECONDS,
} from './constants.ts';
import type { FeatureFlagFetcher, FeatureFlagIdentity } from './types.ts';

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

function selectFlagDecisions(
  allFlags: Record<string, unknown>,
  flagKeys: readonly string[],
): Record<string, boolean> {
  const decisions: Record<string, boolean> = {};
  for (const key of flagKeys) {
    decisions[key] = allFlags[key] === true;
  }
  return decisions;
}

/**
 * Fetches Private Beta flag values via the LaunchDarkly client-side SDK.
 * Failures and missing client-side IDs yield `false` for every requested key.
 */
export const fetchFlagsFromLaunchDarkly: FeatureFlagFetcher = async (identity, flagKeys) => {
  const denied = Object.fromEntries(flagKeys.map((key) => [key, false]));
  const clientSideId = LAUNCHDARKLY_CLIENT_SIDE_ID;
  if (!clientSideId || flagKeys.length === 0) {
    return denied;
  }

  const context = buildLaunchDarklyContext(identity);
  if (!context) {
    return denied;
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
    return selectFlagDecisions(client.allFlags(), flagKeys);
  } catch (err) {
    logger.debug(`LaunchDarkly flag refresh failed: ${(err as Error).message}`);
    return denied;
  } finally {
    await client.close().catch(() => undefined);
  }
};
