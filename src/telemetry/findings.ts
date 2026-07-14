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

import { version as VERSION } from '../../package.json';
import { detectCallerAgent } from '../lib/agent-detector.js';
import type { ResolvedAuth } from '../lib/auth-resolver.js';
import { getTelemetryDir, TELEMETRY_API_KEY, TELEMETRY_ENDPOINT } from '../lib/config-constants.js';
import { buildFetchInit, fetchGuarded } from '../lib/fetch-guarded.js';
import { INVOCATION_ID } from '../lib/invocation-id.js';
import type {
  AnalysisCompletedEventPayload,
  AnalysisEventIdentityPayload,
  AuthConnection,
  CommandExecutedEventPayload,
  IntegrationConfiguredEventPayload,
  StoredAnalysisEvent,
  TelemetryConnectionType,
} from '../lib/state.js';
import { getActiveConnection, loadState } from '../lib/state-manager.js';
import { isTelemetryEnabled } from './enabled.js';
import {
  resolveCommandTelemetryIdentity,
  resolveStoreEventTelemetryIdentitySafely,
  type TelemetryIdentity,
} from './identity.js';
import { getOrCreateUserId } from './user.js';

const FINDINGS_FILENAME = 'findings.ndjson';
const FINDINGS_RETENTION_DAYS = 7;
const FINDINGS_RETENTION_MS = FINDINGS_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function getFindingsPath(): string {
  return join(getTelemetryDir(), FINDINGS_FILENAME);
}

export function appendAnalysisEvent(event: StoredAnalysisEvent): void {
  try {
    mkdirSync(getTelemetryDir(), { recursive: true });
    appendFileSync(getFindingsPath(), JSON.stringify(event) + '\n');
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
): Promise<AnalysisEventIdentityPayload | null> {
  const state = loadState();
  if (!isTelemetryEnabled(state)) return null;
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
  };
}

export type AnalysisCompletedFields = Omit<
  AnalysisCompletedEventPayload,
  keyof AnalysisEventIdentityPayload
>;

export type IntegrationConfiguredFields = Omit<
  IntegrationConfiguredEventPayload,
  keyof AnalysisEventIdentityPayload
>;

export type CommandExecutedFields = Omit<
  CommandExecutedEventPayload,
  keyof AnalysisEventIdentityPayload
>;

/**
 * Emits one CliAnalysisCompleted event when telemetry is enabled.
 * Resolves identity from state + auth; no-ops on opt-out or missing installationId.
 */
export async function emitAnalysisCompleted(
  auth: ResolvedAuth,
  fields: AnalysisCompletedFields,
): Promise<void> {
  const base = await buildIdentityBase((conn) => resolveCommandTelemetryIdentity(conn, auth));
  if (!base) return;
  appendAnalysisEvent({
    metadata: {
      event_id: randomUUID(),
      source: { domain: 'CLI' },
      event_type: 'Analytics.Cli.CliAnalysisCompleted',
      event_timestamp: String(Date.now()),
    },
    event_payload: { ...base, ...fields },
  });
}

/**
 * Emits one CliIntegrationConfigured event when telemetry is enabled.
 * Resolves identity from state + auth; no-ops on opt-out or missing installationId.
 */
export async function emitIntegrationConfigured(
  auth: ResolvedAuth,
  fields: IntegrationConfiguredFields,
): Promise<void> {
  const base = await buildIdentityBase((conn) => resolveCommandTelemetryIdentity(conn, auth));
  if (!base) return;
  appendAnalysisEvent({
    metadata: {
      event_id: randomUUID(),
      source: { domain: 'CLI' },
      event_type: 'Analytics.Cli.CliIntegrationConfigured',
      event_timestamp: String(Date.now()),
    },
    event_payload: { ...base, ...fields },
  });
}

/**
 * Emits one CliCommandExecuted event when telemetry is enabled.
 * Resolves identity from the active connection; no-ops on opt-out or missing installationId.
 */
export async function emitCommandExecuted(fields: CommandExecutedFields): Promise<void> {
  const base = await buildIdentityBase(resolveStoreEventTelemetryIdentitySafely);
  if (!base) return;
  appendAnalysisEvent({
    metadata: {
      event_id: randomUUID(),
      source: { domain: 'CLI' },
      event_type: 'Analytics.Cli.CliCommandExecuted',
      event_timestamp: String(Date.now()),
    },
    event_payload: { ...base, ...fields },
  });
}

function parseValidEvents(content: string, now: number): StoredAnalysisEvent[] {
  const events: StoredAnalysisEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as StoredAnalysisEvent;
      const ts = Number(event.metadata.event_timestamp);
      if (!Number.isNaN(ts) && now - ts <= FINDINGS_RETENTION_MS) {
        events.push(event);
      }
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

/**
 * Atomically drains findings.ndjson: renames it to a UUID-suffixed .sending file so
 * concurrent flush workers each get their own slice, parses valid lines, discards
 * events older than 7 days, then POSTs each remaining event to the telemetry backend.
 * Unsent events (deadline reached or send error) are re-appended to findings.ndjson
 * for the next flush attempt. The .sending file is deleted in all cases.
 */
export async function flushFindings(deadline: number): Promise<void> {
  const findingsPath = getFindingsPath();
  if (!existsSync(findingsPath)) return;

  const sendingPath = join(getTelemetryDir(), `findings.${randomUUID()}.sending`);
  try {
    renameSync(findingsPath, sendingPath);
  } catch {
    // ENOENT: another flush worker won the rename race — nothing to drain.
    // Any other error is also swallowed: flushFindings only runs in the detached
    // flush-telemetry worker, so failures here never surface to the user.
    return;
  }

  const unsent: StoredAnalysisEvent[] = [];

  try {
    const events = parseValidEvents(readFileSync(sendingPath, 'utf-8'), Date.now());
    const sentIndices = new Set<number>();

    for (let i = 0; i < events.length; i++) {
      const remainingTime = deadline - Date.now();
      if (remainingTime <= 0) break;
      try {
        await fetchGuarded(
          TELEMETRY_ENDPOINT,
          buildFetchInit(
            'POST',
            { 'Content-Type': 'application/json', 'x-api-key': TELEMETRY_API_KEY },
            remainingTime,
            JSON.stringify(events[i], (_key, value) => (value === null ? undefined : value)),
          ),
        );
        sentIndices.add(i);
      } catch {
        // event remains in unsent for the next flush attempt
      }
    }

    unsent.push(...events.filter((_, i) => !sentIndices.has(i)));
  } finally {
    if (unsent.length > 0) {
      try {
        appendFileSync(getFindingsPath(), unsent.map((e) => JSON.stringify(e)).join('\n') + '\n');
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
