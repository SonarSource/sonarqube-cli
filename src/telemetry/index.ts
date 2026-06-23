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

import { type Command } from 'commander';

import { version as VERSION } from '../../package.json';
import { detectCallerAgent } from '../lib/agent-detector.js';
import { TELEMETRY_API_KEY, TELEMETRY_ENDPOINT } from '../lib/config-constants.js';
import { DISTRIBUTION } from '../lib/distribution.js';
import { buildFetchInit, fetchGuarded } from '../lib/fetch-guarded.js';
import { INVOCATION_ID } from '../lib/invocation-id.js';
import type { StoredTelemetryEvent, TelemetryEventPayload } from '../lib/state.js';
import { getActiveConnection, loadState, saveState } from '../lib/state-manager.js';
import { isTelemetryEnabled } from './enabled.js';
import { flushFindings } from './findings.js';
import { getOrCreateUserId } from './user.js';

export const TELEMETRY_FLUSH_MODE_ENV = '__SQ_CLI_TELEMETRY_FLUSH__';

// Passthrough commands (e.g. `sonar context`) own a single Command node, so the
// usual parent-chain walk cannot recover the forwarded subcommand. The handler
// publishes the resolved subcommand here and storeEvent reads it back.
const passthroughSubcommands = new WeakMap<Command, string | null>();

export function setPassthroughSubcommand(command: Command, subcommand: string | null): void {
  passthroughSubcommands.set(command, subcommand);
}

/**
 * Append one event to the pending batch and spawn a detached flush worker.
 * No-ops when called from within a flush worker to prevent infinite recursion.
 */
export function storeEvent(command: Command, success: boolean): Promise<void> {
  if (process.env[TELEMETRY_FLUSH_MODE_ENV]) return Promise.resolve();

  const state = loadState();

  if (!isTelemetryEnabled(state)) {
    return Promise.resolve();
  }
  const commandNames: string[] = [];
  let current: Command = command;
  while (current.parent !== null) {
    commandNames.unshift(current.name());
    current = current.parent;
  }
  const topCommand = commandNames[0];
  const commandPathTail = commandNames.slice(1);
  const fallbackSubcommand = commandPathTail.length > 0 ? commandPathTail.join(' ') : null;
  let subcommand: string | null;
  if (passthroughSubcommands.has(command)) {
    subcommand = passthroughSubcommands.get(command) ?? null;
  } else {
    subcommand = fallbackSubcommand;
  }

  const conn = getActiveConnection(state);
  const connectionType: 'sqc' | 'sqs' | null =
    conn?.type === 'cloud' ? 'sqc' : conn?.type === 'on-premise' ? 'sqs' : null;

  const eventPayload: TelemetryEventPayload = {
    cli_installation_id: state.telemetry.installationId!,
    machine_id: getOrCreateUserId(),
    cli_version: VERSION,
    command: topCommand,
    subcommand,
    invocation_id: INVOCATION_ID,
    result: success ? 'success' : 'failure',
    os: process.platform,
    connection_type: connectionType,
    user_uuid: conn?.userUuid ?? null,
    organization_uuid_v4: conn?.organizationUuidV4 ?? null,
    sqs_installation_id: conn?.sqsInstallationId ?? null,
    distribution: DISTRIBUTION,
    caller_agent: detectCallerAgent(),
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
  const env = { ...process.env, [TELEMETRY_FLUSH_MODE_ENV]: '1' };

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
  if (!isTelemetryEnabled(state)) {
    return;
  }

  const deadline = Date.now() + FLUSH_TIMEOUT_MS;
  const telemetry = state.telemetry;

  if (telemetry.events.length > 0) {
    const sentIndices = new Set<number>();

    for (let i = 0; i < telemetry.events.length; i++) {
      const remainingTime = deadline - Date.now();
      if (remainingTime <= 0) break;
      try {
        await fetchGuarded(
          TELEMETRY_ENDPOINT,
          buildFetchInit(
            'POST',
            { 'Content-Type': 'application/json', 'x-api-key': TELEMETRY_API_KEY },
            remainingTime,
            JSON.stringify(telemetry.events[i], (_key, value) =>
              value === null ? undefined : value,
            ),
          ),
        );

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

  await flushFindings(deadline);
}
