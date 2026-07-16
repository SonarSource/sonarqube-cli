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

import { type Command } from 'commander';

import { DISTRIBUTION } from '../lib/distribution.js';
import { tryLoadState } from '../lib/state-manager.js';
import { isTelemetryEnabled } from './enabled.js';
import { emitCommandExecuted, flushTelemetryEvents } from './telemetry-events.js';

export const TELEMETRY_FLUSH_MODE_ENV = '__SQ_CLI_TELEMETRY_FLUSH__';

// Passthrough commands (e.g. `sonar context`) own a single Command node, so the
// usual parent-chain walk cannot recover the forwarded subcommand. The handler
// publishes the resolved subcommand here and storeEvent reads it back.
const passthroughSubcommands = new WeakMap<Command, string | null>();

export function setPassthroughSubcommand(command: Command, subcommand: string | null): void {
  passthroughSubcommands.set(command, subcommand);
}

/**
 * Emit one CliCommandExecuted event for a finished command and spawn the detached flush
 * worker that drains telemetry-events.ndjson.
 *
 * No-ops when called from within a flush worker (prevents infinite recursion) or when
 * telemetry is disabled.
 */
export async function storeEvent(command: Command, success: boolean): Promise<void> {
  if (process.env[TELEMETRY_FLUSH_MODE_ENV]) return;
  const state = tryLoadState();
  if (!state || !isTelemetryEnabled(state)) return;

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

  await emitCommandExecuted({
    command: topCommand,
    subcommand,
    result: success ? 'success' : 'failure',
    distribution: DISTRIBUTION,
  });

  spawnFlushWorker();
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
 * Drain telemetry-events.ndjson to the telemetry backend, stopping after FLUSH_TIMEOUT_MS (1 minute).
 * Called by the hidden `sonar flush-telemetry` command.
 */
export async function flushTelemetry(): Promise<void> {
  const state = tryLoadState();
  if (!state || !isTelemetryEnabled(state)) {
    return;
  }

  const deadline = Date.now() + FLUSH_TIMEOUT_MS;
  await flushTelemetryEvents(deadline);
}
