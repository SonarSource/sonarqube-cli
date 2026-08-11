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

import type { SonarCommand } from '@/commands/sonar-command.ts';
import { resolveAuth } from '@/core/auth/auth-resolver.ts';
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
import { LAUNCHDARKLY_CLIENT_SIDE_ID } from './constants.ts';
import { fetchFlagsFromLaunchDarkly } from './launchdarkly.ts';
import type { FeatureFlagFetcher, FeatureFlagIdentity } from './types.ts';

export interface ApplyPrivateBetaGatingOptions {
  fetchFlags?: FeatureFlagFetcher;
  nowMs?: number;
  clientSideId?: string;
}

function collectPrivateBetaCommands(root: SonarCommand): SonarCommand[] {
  const collected: SonarCommand[] = [];

  const visit = (command: SonarCommand): void => {
    if (command.isPrivateBeta) {
      collected.push(command);
    }
    for (const child of command.commands as SonarCommand[]) {
      visit(child);
    }
  };

  visit(root);
  return collected;
}

function unregisterCommands(commands: readonly SonarCommand[]): void {
  for (const command of commands) {
    command.unregisterFromParent();
  }
}

async function resolveFeatureFlagIdentity(): Promise<FeatureFlagIdentity | null> {
  const auth = await resolveAuth({ silent: true });
  if (!auth) {
    return null;
  }

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

/**
 * Removes Private Beta commands the current identity is not entitled to.
 *
 * No-op when the tree has no Private Beta commands, so Stable / Open Beta
 * startups never contact LaunchDarkly. Uses a 12-hour local cache; refreshes
 * only when a needed decision is missing or expired.
 */
export async function applyPrivateBetaGating(
  root: SonarCommand,
  options: ApplyPrivateBetaGatingOptions = {},
): Promise<void> {
  const privateBetaCommands = collectPrivateBetaCommands(root);
  if (privateBetaCommands.length === 0) {
    return;
  }

  const flagKeys = [
    ...new Set(
      privateBetaCommands
        .map((command) => command.betaFlagKey)
        .filter((key): key is string => typeof key === 'string' && key.length > 0),
    ),
  ];

  const clientSideId = options.clientSideId ?? LAUNCHDARKLY_CLIENT_SIDE_ID;
  const nowMs = options.nowMs ?? Date.now();
  const fetchFlags = options.fetchFlags ?? fetchFlagsFromLaunchDarkly;

  let decisions: Record<string, boolean>;

  try {
    const identity = await resolveFeatureFlagIdentity();
    if (!identity || !clientSideId) {
      unregisterCommands(privateBetaCommands);
      return;
    }

    const cached = readFreshFlagDecisions(identity, flagKeys, clientSideId, nowMs);
    if (cached) {
      decisions = cached;
    } else {
      decisions = await fetchFlags(identity, flagKeys);
      writeFlagDecisions(identity, decisions, clientSideId, nowMs);
    }
  } catch (err) {
    logger.debug(`Private Beta gating failed: ${(err as Error).message}`);
    unregisterCommands(privateBetaCommands);
    return;
  }

  const denied = privateBetaCommands.filter(
    (command) => command.betaFlagKey !== undefined && !decisions[command.betaFlagKey],
  );
  unregisterCommands(denied);
}
