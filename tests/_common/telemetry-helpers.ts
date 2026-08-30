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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AnalysisCompletedPayload } from '@/commands/analyze/analysis-completed.ts';
import type {
  CliState,
  StoredTelemetryEvent,
  TelemetryEventIdentityPayload,
} from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';

export type StoredAnalysisCompletedEvent = StoredTelemetryEvent & {
  event_payload: TelemetryEventIdentityPayload & AnalysisCompletedPayload & Record<string, unknown>;
};
export type StoredCommandExecutedEvent = StoredTelemetryEvent;
export type StoredIntegrationConfiguredEvent = StoredTelemetryEvent;

export function makeTelemetryState(enabled = true): CliState {
  const state = getDefaultState('1.0.0');
  state.telemetry.enabled = enabled;
  state.telemetry.installationId = 'install-id';
  return state;
}

export function telemetryEventsPath(sonarUserHome: string): string {
  return join(sonarUserHome, 'sonarqube-cli', 'telemetry', 'telemetry-events.ndjson');
}

export function readTelemetryEvents<T extends StoredTelemetryEvent = StoredTelemetryEvent>(
  sonarUserHome: string,
  eventType: T['metadata']['event_type'],
): T[] {
  const path = telemetryEventsPath(sonarUserHome);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredTelemetryEvent)
    .filter((event) => event.metadata.event_type === eventType) as T[];
}

export function readAnalysisEvents(sonarUserHome: string): StoredAnalysisCompletedEvent[] {
  return readTelemetryEvents<StoredAnalysisCompletedEvent>(
    sonarUserHome,
    'Analytics.Cli.CliAnalysisCompleted',
  );
}

export function readCommandEvents(sonarUserHome: string): StoredCommandExecutedEvent[] {
  return readTelemetryEvents<StoredCommandExecutedEvent>(
    sonarUserHome,
    'Analytics.Cli.CliCommandExecuted',
  );
}

export function readIntegrationEvents(sonarUserHome: string): StoredIntegrationConfiguredEvent[] {
  return readTelemetryEvents<StoredIntegrationConfiguredEvent>(
    sonarUserHome,
    'Analytics.Cli.CliIntegrationConfigured',
  );
}

export function writeTelemetryEvent(sonarUserHome: string, event: StoredTelemetryEvent): void {
  const path = telemetryEventsPath(sonarUserHome);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + '\n');
}
