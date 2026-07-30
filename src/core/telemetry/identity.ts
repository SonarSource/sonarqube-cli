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

import { resolveAuth, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import {
  identityFromConnection,
  needsIdentityEnrichment,
  resolveTelemetryIdentity,
  type TelemetryIdentity,
} from '@/core/host/identity-fetch.ts';
import { authMatchesConnection } from '@/core/state/state-manager.ts';

import type { AuthConnection, ServerType, TelemetryConnectionType } from '../state/state.ts';

export type { TelemetryIdentity } from '@/core/host/identity-fetch.ts';
export {
  identityFromConnection,
  isIdentityCompleteForConnection,
} from '@/core/host/identity-fetch.ts';

function toTelemetryConnectionType(type: ServerType): Exclude<TelemetryConnectionType, null> {
  return type === 'cloud' ? 'sqc' : 'sqs';
}

function matchingConnection(
  conn: AuthConnection | undefined,
  auth: ResolvedAuth | null,
): AuthConnection | undefined {
  if (conn === undefined) return undefined;
  if (auth && !authMatchesConnection(auth, conn)) return undefined;
  return conn;
}

/** Trusts an already-complete `conn` to skip a redundant `resolveAuth()`. */
async function resolveStoreEventTelemetryIdentity(
  conn: AuthConnection | undefined,
): Promise<{ connectionType: TelemetryConnectionType; identity: TelemetryIdentity }> {
  if (conn && !needsIdentityEnrichment(identityFromConnection(conn), conn.type, conn)) {
    return {
      connectionType: toTelemetryConnectionType(conn.type),
      identity: identityFromConnection(conn),
    };
  }
  const auth = await resolveAuth({ silent: true });
  return resolveCommandTelemetryIdentity(conn, auth);
}

/**
 * Like {@link resolveStoreEventTelemetryIdentity}, but never throws — telemetry
 * must not fail an otherwise-successful command.
 */
export async function resolveStoreEventTelemetryIdentitySafely(
  conn: AuthConnection | undefined,
): Promise<{ connectionType: TelemetryConnectionType; identity: TelemetryIdentity }> {
  try {
    return await resolveStoreEventTelemetryIdentity(conn);
  } catch {
    return {
      connectionType: conn ? toTelemetryConnectionType(conn.type) : null,
      identity: identityFromConnection(conn),
    };
  }
}

export async function resolveCommandTelemetryIdentity(
  conn: AuthConnection | undefined,
  auth: ResolvedAuth | null,
): Promise<{ connectionType: TelemetryConnectionType; identity: TelemetryIdentity }> {
  const seedConn = matchingConnection(conn, auth);
  let identity = identityFromConnection(seedConn);
  let connectionType: TelemetryConnectionType = seedConn
    ? toTelemetryConnectionType(seedConn.type)
    : null;

  if (auth) {
    connectionType = toTelemetryConnectionType(auth.connectionType);
    if (needsIdentityEnrichment(identity, auth.connectionType, seedConn)) {
      identity = await resolveTelemetryIdentity(auth, identity);
    }
  }

  return { connectionType, identity };
}
