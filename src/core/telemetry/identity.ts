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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import {
  CommandAuthenticatedInvocationContext,
  type CommandInvocationContext,
} from '@/core/commands/invocation-context.ts';
import {
  authMatchesConnection,
  getActiveConnection,
  tryLoadState,
} from '@/core/state/state-manager.ts';
import {
  EMPTY_IDENTITY,
  identityFromConnection,
  needsIdentityEnrichment,
  resolveTelemetryIdentity,
  type TelemetryIdentity,
} from '@/core/telemetry/identity-fetch.ts';

import type { AuthConnection, ServerType, TelemetryConnectionType } from '../state/state.ts';

export type { TelemetryIdentity } from '@/core/telemetry/identity-fetch.ts';
export {
  identityFromConnection,
  isIdentityCompleteForConnection,
} from '@/core/telemetry/identity-fetch.ts';

function toTelemetryConnectionType(type: ServerType): Exclude<TelemetryConnectionType, null> {
  return type === 'cloud' ? 'sqc' : 'sqs';
}

/**
 * Store events have no invocation auth (flush worker, unthreaded emits), so identity
 * is whatever the active connection already holds. Pure — no I/O, nothing to fail.
 */
export function resolveStoreEventTelemetryIdentity(conn: AuthConnection | undefined): {
  connectionType: TelemetryConnectionType;
  identity: TelemetryIdentity;
} {
  return {
    connectionType: conn ? toTelemetryConnectionType(conn.type) : null,
    identity: identityFromConnection(conn),
  };
}

export async function resolveCommandTelemetryIdentity(
  auth: ResolvedAuth | null,
): Promise<{ connectionType: TelemetryConnectionType; identity: TelemetryIdentity }> {
  if (!auth) {
    return { connectionType: null, identity: EMPTY_IDENTITY };
  }

  const connectionType = toTelemetryConnectionType(auth.connectionType);
  const state = tryLoadState();
  const active = state ? getActiveConnection(state) : undefined;
  const seedConn = active && authMatchesConnection(auth, active) ? active : undefined;
  const seed = identityFromConnection(seedConn);

  if (seedConn && !needsIdentityEnrichment(seed, auth.connectionType, seedConn)) {
    return { connectionType, identity: seed };
  }

  return {
    connectionType,
    identity: await resolveTelemetryIdentity(auth, seed),
  };
}

/**
 * Auth for telemetry when draining handler facts: authenticated handlers expose
 * `ctx.auth`; anonymous handlers resolve once via the invocation context.
 */
export async function resolveInvocationAuthForTelemetry(
  ctx: CommandInvocationContext | undefined,
): Promise<ResolvedAuth | null | undefined> {
  if (!ctx) {
    return undefined;
  }
  if (ctx instanceof CommandAuthenticatedInvocationContext) {
    return ctx.auth;
  }
  const result = await ctx.resolveAuth({ silent: true });
  if (result.isErr()) {
    return null;
  }
  return result.value;
}
