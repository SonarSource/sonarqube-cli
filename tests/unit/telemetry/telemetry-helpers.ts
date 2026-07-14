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

import type { CliState, StoredAnalysisEvent } from '../../../src/lib/state.js';
import { getDefaultState } from '../../../src/lib/state.js';

export function makeTelemetryState(enabled = true): CliState {
  const state = getDefaultState('1.0.0');
  state.telemetry.enabled = enabled;
  state.telemetry.installationId = 'install-id';
  return state;
}

export function telemetryEventsPath(sonarUserHome: string): string {
  return join(sonarUserHome, 'sonarqube-cli', 'telemetry', 'findings.ndjson');
}

export function readTelemetryEvents<T extends StoredAnalysisEvent = StoredAnalysisEvent>(
  sonarUserHome: string,
): T[] {
  const path = telemetryEventsPath(sonarUserHome);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function writeTelemetryEvent(sonarUserHome: string, event: StoredAnalysisEvent): void {
  const path = telemetryEventsPath(sonarUserHome);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + '\n');
}
