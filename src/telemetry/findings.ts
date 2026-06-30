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
  AnalysisFindingEventPayload,
  AnalysisFindingsDetectedEventPayload,
  StoredAnalysisEvent,
} from '../lib/state.js';
import { getActiveConnection, loadState } from '../lib/state-manager.js';
import { isTelemetryEnabled } from './enabled.js';
import { getOrCreateUserId } from './user.js';

const FINDINGS_FILENAME = 'findings.ndjson';
const FINDINGS_RETENTION_DAYS = 7;
const FINDINGS_RETENTION_MS = FINDINGS_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function getFindingsPath(): string {
  return join(getTelemetryDir(), FINDINGS_FILENAME);
}

function appendAnalysisEvent(event: StoredAnalysisEvent): void {
  try {
    mkdirSync(getTelemetryDir(), { recursive: true });
    appendFileSync(getFindingsPath(), JSON.stringify(event) + '\n');
  } catch {
    // fire-and-forget
  }
}

/**
 * Resolves shared identity fields for analysis telemetry events.
 * Returns null when telemetry is disabled or installationId is absent.
 */
export function buildAnalysisIdentityBase(auth: ResolvedAuth): AnalysisEventIdentityPayload | null {
  const state = loadState();
  if (!isTelemetryEnabled(state)) return null;
  const installationId = state.telemetry.installationId;
  if (!installationId) return null;

  const conn = getActiveConnection(state);
  return {
    cli_installation_id: installationId,
    machine_id: getOrCreateUserId(),
    cli_version: VERSION,
    invocation_id: INVOCATION_ID,
    os: process.platform,
    connection_type: auth.connectionType === 'cloud' ? 'sqc' : 'sqs',
    user_uuid: conn?.userUuid ?? null,
    organization_uuid_v4: conn?.organizationUuidV4 ?? null,
    sqs_installation_id: conn?.sqsInstallationId ?? null,
    caller_agent: detectCallerAgent(),
  };
}

/**
 * Appends one CliAnalysisCompleted event to findings.ndjson. Fire-and-forget.
 */
export function appendAnalysisCompleted(payload: AnalysisCompletedEventPayload): void {
  appendAnalysisEvent({
    metadata: {
      event_id: randomUUID(),
      source: { domain: 'CLI' },
      event_type: 'Analytics.Cli.CliAnalysisCompleted',
      event_timestamp: String(Date.now()),
    },
    event_payload: payload,
  });
}

/**
 * Appends one CliAnalysisFindingsDetected event to findings.ndjson. Fire-and-forget.
 */
export function appendAnalysisFindingsDetected(
  payload: AnalysisFindingsDetectedEventPayload,
): void {
  appendAnalysisEvent({
    metadata: {
      event_id: randomUUID(),
      source: { domain: 'CLI' },
      event_type: 'Analytics.Cli.CliAnalysisFindingsDetected',
      event_timestamp: String(Date.now()),
    },
    event_payload: payload,
  });
}

/**
 * Appends one CliAnalysisFindingDetected event to findings.ndjson. Fire-and-forget:
 * creates the directory if missing and silently swallows all I/O errors.
 */
export function appendFinding(payload: AnalysisFindingEventPayload): void {
  appendAnalysisEvent({
    metadata: {
      event_id: randomUUID(),
      source: { domain: 'CLI' },
      event_type: 'Analytics.Cli.CliAnalysisFindingDetected',
      event_timestamp: String(Date.now()),
    },
    event_payload: payload,
  });
}

/**
 * Emits one CliAnalysisFindingDetected event per issue from a sonar-secrets scan.
 * No-ops on clean scans (empty issues) and when telemetry is disabled.
 * Identity fields are resolved from state + auth on each call.
 */
export function emitSecretsFindings(
  callerCommand: string,
  auth: ResolvedAuth,
  issues: ReadonlyArray<{ ruleKey: string }>,
  durationMs: number,
): void {
  if (issues.length === 0) return;
  const base = buildAnalysisIdentityBase(auth);
  if (!base) return;

  for (const issue of issues) {
    appendFinding({
      ...base,
      caller_command: callerCommand,
      analyzer: 'sonar-secrets',
      rule_key: issue.ruleKey,
      scan_duration_ms: durationMs,
    });
  }
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
