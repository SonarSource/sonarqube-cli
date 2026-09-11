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

import { type TelemetryFact } from '@/core/commands/invocation-context.ts';

import { tryLoadState } from '../state/state-manager.ts';
import { resolveTelemetryEgress } from './egress.ts';
import { isTelemetryEnabled } from './enabled.ts';
import {
  emitTelemetryEvent,
  flushTelemetryEvents,
  type IdentityEmitOptions,
} from './telemetry-events.ts';

export const TELEMETRY_FLUSH_MODE_ENV = '__SQ_CLI_TELEMETRY_FLUSH__';

/**
 * Drain recorded telemetry facts through the generic telemetry emit, then spawn
 * the detached flush worker. Identity / invocation correlation are applied in
 * core; emit failures are swallowed.
 *
 * No-ops when called from within a flush worker (prevents infinite recursion).
 */
export async function commitTelemetryFacts(
  facts: readonly TelemetryFact[],
  options?: IdentityEmitOptions,
): Promise<void> {
  if (process.env[TELEMETRY_FLUSH_MODE_ENV]) return;

  for (const fact of facts) {
    try {
      await emitTelemetryEvent(fact.name, fact.payload as object, {
        eventTimestampMs: fact.timestamp,
        agentSessionId: options?.agentSessionId,
        auth: fact.auth ?? options?.auth,
      });
    } catch {
      // Telemetry is strictly fire-and-forget.
    }
  }

  scheduleTelemetryFlush();
}

/**
 * Spawn the detached flush worker when consent and egress allow it.
 * Called by {@link commitTelemetryFacts} after appending events.
 */
function scheduleTelemetryFlush(): void {
  if (process.env[TELEMETRY_FLUSH_MODE_ENV]) return;
  const state = tryLoadState();
  if (!state || !isTelemetryEnabled(state)) return;
  if (resolveTelemetryEgress().kind !== 'off') {
    spawnFlushWorker();
  }
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
  // Guarded here rather than inside flushTelemetryEvents, which stays an unconditional
  // drain: returning early leaves the queue on disk for a later attempt.
  if (resolveTelemetryEgress().kind === 'off') {
    return;
  }

  const deadline = Date.now() + FLUSH_TIMEOUT_MS;
  await flushTelemetryEvents(deadline);
}
