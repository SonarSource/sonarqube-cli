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

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { NetworkConfigError } from '@/core/errors.ts';
import { detectCallerAgent } from '@/core/host/environment/agent-detector.ts';
import { buildFetchInit, fetchGuarded } from '@/core/server/fetch-guarded.ts';
import { INVOCATION_ID } from '@/core/telemetry/invocation-id.ts';

import { version as VERSION } from '../../../package.json';
import { getTelemetryDir, TELEMETRY_API_KEY, TELEMETRY_ENDPOINT } from '../config-constants.ts';
import type {
  AuthConnection,
  StoredTelemetryEvent,
  TelemetryConnectionType,
  TelemetryEventIdentityPayload,
} from '../state/state.ts';
import { getActiveConnection, tryLoadState } from '../state/state-manager.ts';
import { resolveAgentSessionIdFromHookOrEnv } from './agent-session.ts';
import { isTelemetryEnabled } from './enabled.ts';
import {
  resolveCommandTelemetryIdentity,
  resolveStoreEventTelemetryIdentitySafely,
  type TelemetryIdentity,
} from './identity.ts';
import { getOrCreateUserId } from './user.ts';

const TELEMETRY_EVENTS_FILENAME = 'telemetry-events.ndjson';
const TELEMETRY_EVENTS_RETENTION_DAYS = 7;
const TELEMETRY_EVENTS_RETENTION_MS = TELEMETRY_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Per-request ceiling for a telemetry POST. Without it a single unresponsive endpoint —
 * typically a proxy that blackholes rather than rejects — consumes the whole flush deadline,
 * leaving the detached worker alive for minutes and starving the rest of the batch.
 */
const TELEMETRY_REQUEST_TIMEOUT_MS = 20_000;

function getTelemetryEventsPath(): string {
  return join(getTelemetryDir(), TELEMETRY_EVENTS_FILENAME);
}

export function appendTelemetryEvent(event: StoredTelemetryEvent): void {
  try {
    mkdirSync(getTelemetryDir(), { recursive: true });
    appendFileSync(getTelemetryEventsPath(), JSON.stringify(event) + '\n');
  } catch {
    // fire-and-forget
  }
}

type IdentityResolver = (
  conn: AuthConnection | undefined,
) => Promise<{ connectionType: TelemetryConnectionType; identity: TelemetryIdentity }>;

/**
 * Resolves shared identity fields for telemetry events.
 * Returns null when telemetry is disabled or installationId is absent.
 */
async function buildIdentityBase(
  resolve: IdentityResolver,
  identityOptions?: IdentityEmitOptions,
): Promise<TelemetryEventIdentityPayload | null> {
  const state = tryLoadState();
  if (!state || !isTelemetryEnabled(state)) return null;
  const installationId = state.telemetry.installationId;
  if (!installationId) return null;

  const conn = getActiveConnection(state);
  const { connectionType, identity } = await resolve(conn);

  return {
    cli_installation_id: installationId,
    machine_id: getOrCreateUserId(),
    cli_version: VERSION,
    invocation_id: INVOCATION_ID,
    os: process.platform,
    connection_type: connectionType,
    user_uuid: identity.user_uuid,
    organization_uuid_v4: identity.organization_uuid_v4,
    sqs_installation_id: identity.sqs_installation_id,
    caller_agent: detectCallerAgent(),
    agent_session_id: resolveAgentSessionIdFromHookOrEnv(identityOptions?.agentSessionId ?? null),
  };
}

/** Wire `event_type` prefix. Domain producers pass the short name only. */
export const TELEMETRY_EVENT_TYPE_PREFIX = 'Analytics.Cli.';

export type IdentityEmitOptions = {
  /**
   * Agent session id for this emit. Prefers a hook-payload id when given;
   * otherwise `buildIdentityBase` falls back to agent-native env vars.
   */
  agentSessionId?: string | null;
};

export type TelemetryEmitOptions = IdentityEmitOptions & {
  eventTimestampMs?: number;
  /** When set, identity is resolved from this auth; otherwise the active connection. */
  auth?: ResolvedAuth;
};

/**
 * Appends one telemetry event. `name` is the short event name; identity and the
 * `Analytics.Cli.` prefix are applied here. `fields` is an opaque domain payload.
 */
export async function emitTelemetryEvent(
  name: string,
  fields: object,
  options?: TelemetryEmitOptions,
): Promise<void> {
  const auth = options?.auth;
  const resolve: IdentityResolver =
    auth === undefined
      ? resolveStoreEventTelemetryIdentitySafely
      : (conn) => resolveCommandTelemetryIdentity(conn, auth);
  const base = await buildIdentityBase(resolve, options);
  if (!base) return;
  appendTelemetryEvent({
    metadata: {
      event_id: randomUUID(),
      source: { domain: 'CLI' },
      event_type: `${TELEMETRY_EVENT_TYPE_PREFIX}${name}`,
      event_timestamp: String(options?.eventTimestampMs ?? Date.now()),
    },
    event_payload: { ...base, ...fields },
  });
}

function parseValidEvents(content: string, now: number): StoredTelemetryEvent[] {
  const events: StoredTelemetryEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as StoredTelemetryEvent;
      const ts = Number(event.metadata.event_timestamp);
      if (!Number.isNaN(ts) && now - ts <= TELEMETRY_EVENTS_RETENTION_MS) {
        events.push(event);
      }
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

/**
 * POSTs one event. `requeue` leaves it for the next flush attempt; `abort` means the
 * proxy/TLS configuration is unusable, so the rest of the batch is not worth attempting.
 */
async function sendTelemetryEvent(
  event: StoredTelemetryEvent,
  timeoutMs: number,
): Promise<'sent' | 'requeue' | 'abort'> {
  try {
    await fetchGuarded(
      TELEMETRY_ENDPOINT,
      buildFetchInit(
        'POST',
        { 'Content-Type': 'application/json', 'x-api-key': TELEMETRY_API_KEY },
        timeoutMs,
        JSON.stringify(event, (_key, value) => (value === null ? undefined : value)),
      ),
    );
    return 'sent';
  } catch (err) {
    return err instanceof NetworkConfigError ? 'abort' : 'requeue';
  }
}

/**
 * Atomically drains telemetry-events.ndjson: renames it to a UUID-suffixed .sending file so
 * concurrent flush workers each get their own slice, parses valid lines, discards
 * events older than 7 days, then POSTs each remaining event to the telemetry backend.
 * Unsent events (deadline reached or send error) are re-appended to telemetry-events.ndjson
 * for the next flush attempt. The .sending file is deleted in all cases.
 *
 * Requests carry the resolved proxy/TLS configuration; when that configuration cannot be
 * resolved the whole batch is requeued rather than sent without it. Each request is capped at
 * TELEMETRY_REQUEST_TIMEOUT_MS, independently of how much of the deadline is left.
 *
 * Transmits unconditionally: consent and egress are gated by its caller, `flushTelemetry()`.
 * Any other caller must supply those guards itself.
 */
export async function flushTelemetryEvents(deadline: number): Promise<void> {
  const eventsPath = getTelemetryEventsPath();
  if (!existsSync(eventsPath)) return;

  const sendingPath = join(getTelemetryDir(), `telemetry-events.${randomUUID()}.sending`);
  try {
    renameSync(eventsPath, sendingPath);
  } catch {
    // ENOENT: another flush worker won the rename race — nothing to drain.
    // Any other error is also swallowed: flushTelemetryEvents only runs in the detached
    // flush-telemetry worker, so failures here never surface to the user.
    return;
  }

  const unsent: StoredTelemetryEvent[] = [];

  try {
    const events = parseValidEvents(readFileSync(sendingPath, 'utf-8'), Date.now());
    const sentIndices = new Set<number>();

    for (let i = 0; i < events.length; i++) {
      const remainingTime = deadline - Date.now();
      if (remainingTime <= 0) break;
      const outcome = await sendTelemetryEvent(
        events[i],
        Math.min(remainingTime, TELEMETRY_REQUEST_TIMEOUT_MS),
      );
      if (outcome === 'abort') break;
      if (outcome === 'sent') sentIndices.add(i);
    }

    unsent.push(...events.filter((_, i) => !sentIndices.has(i)));
  } finally {
    if (unsent.length > 0) {
      try {
        appendFileSync(
          getTelemetryEventsPath(),
          unsent.map((e) => JSON.stringify(e)).join('\n') + '\n',
        );
      } catch {
        // fire-and-forget
      }
    }
    try {
      rmSync(sendingPath);
    } catch {
      // ignore cleanup failures
    }
  }
}
