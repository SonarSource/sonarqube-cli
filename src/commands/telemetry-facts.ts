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

import type { TelemetryFact } from '@/commands/command-invocation-context.ts';
import { scheduleTelemetryFlush, TELEMETRY_FLUSH_MODE_ENV } from '@/core/telemetry/index.ts';
import { emitTelemetryEvent, type IdentityEmitOptions } from '@/core/telemetry/telemetry-events.ts';

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
        auth: fact.auth,
      });
    } catch {
      // Telemetry is strictly fire-and-forget.
    }
  }

  scheduleTelemetryFlush();
}
