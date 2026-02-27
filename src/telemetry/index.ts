/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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
import { getActiveConnection, loadState, saveState } from '../lib/state-manager.js';
import type { StoredTelemetryEvent, TelemetryEventPayload } from '../lib/state.js';
import { getOrCreateUserId } from './user.js';
import { type Command } from 'commander';

export const TELEMETRY_FLUSH_MODE_ENV = '__SQ_CLI_TELEMETRY_FLUSH__';

const TELEMETRY_ENDPOINT = 'https://events.sonardata.io/cli';
const TELEMETRY_API_KEY = 'hJPRohLsOsasZeOhSCSNDiL4h2yR96S5fOWJqRch';

/**
 * Append one event to the pending batch and spawn a detached flush worker.
 * No-ops when called from within a flush worker to prevent infinite recursion.
 */
export function storeEvent(command: Command, success: boolean): Promise<void> {
  if (process.env[TELEMETRY_FLUSH_MODE_ENV]) return Promise.resolve();

  const state = loadState();

  if (!state.telemetry.enabled) {
    return Promise.resolve();
  }
  const commandNames: string[] = [];
  let current: Command = command;
  while (current.parent !== null) {
    commandNames.unshift(current.name());
    current = current.parent;
  }
  const topCommand = commandNames[0];
  const subcommand = commandNames.length > 1 ? commandNames.slice(1).join(' ') : null;

  const conn = getActiveConnection(state);
  const connectionType: 'sqc' | 'sqs' | null =
    conn?.type === 'cloud' ? 'sqc' : conn?.type === 'on-premise' ? 'sqs' : null;

  const eventPayload: TelemetryEventPayload = {
    cli_installation_id: state.telemetry.installationId!,
    machine_id: getOrCreateUserId(),
    cli_version: state.version,
    command: topCommand,
    subcommand,
    invocation_id: randomUUID(),
    result: success ? 'success' : 'failure',
    os: process.platform,
    connection_type: connectionType,
    user_uuid: conn?.userUuid ?? null,
    organization_uuid_v4: conn?.organizationUuidV4 ?? null,
    sqs_installation_id: conn?.sqsInstallationId ?? null,
  };

  const event: StoredTelemetryEvent = {
    metadata: {
      event_id: randomUUID(),
      source: {
        domain: 'CLI',
      },
      event_type: 'Analytics.Cli.CliCommandExecuted',
      event_timestamp: String(Date.now()),
    },
    event_payload: eventPayload,
  };

  state.telemetry.events.push(event);
  saveState(state);

  spawnFlushWorker();
  return Promise.resolve();
}

/**
 * Spawn a detached child process that runs `sonar flush telemetry`.
 * proc.unref() lets the parent exit without waiting for the worker.
 */
function spawnFlushWorker() {
  const env = { [TELEMETRY_FLUSH_MODE_ENV]: '1' };

  // In dev mode we run bun directly
  // in compiled-binary mode the entry point is 'sonar'.
  const isDevMode = process.execPath.endsWith('bun');
  const cmd = isDevMode
    ? [process.execPath, process.argv[1], 'flush-telemetry']
    : [process.execPath, 'flush-telemetry'];

  const proc = Bun.spawn(cmd, { env, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
  proc.unref();
}

const FLUSH_TIMEOUT_MS = 60_000;

/**
 * Send each pending event individually to the telemetry backend.
 * The total process stops after FLUSH_TIMEOUT_MS (1 minute).
 * Only successfully sent events are removed from state.
 * Called by the hidden `sonar flush telemetry` command.
 */
export async function flushTelemetry(): Promise<void> {
  const state = loadState();
  if (!state.telemetry.enabled) {
    return;
  }
  const telemetry = state.telemetry;

  if (!telemetry.events.length) return;

  const deadline = Date.now() + FLUSH_TIMEOUT_MS;
  const sentIndices = new Set<number>();

  for (let i = 0; i < telemetry.events.length; i++) {
    const remainingTime = deadline - Date.now();
    if (remainingTime <= 0) break;
    try {
      await fetch(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TELEMETRY_API_KEY,
        },
        body: JSON.stringify(telemetry.events[i], (_key, value) =>
          value === null ? undefined : value,
        ),
        signal: AbortSignal.timeout(remainingTime),
      });

      sentIndices.add(i);
    } catch {
      // Silently fail — event remains for the next flush attempt.
    }
  }

  if (sentIndices.size > 0) {
    telemetry.events = telemetry.events.filter((_, i) => !sentIndices.has(i));
    saveState(state);
  }
}
