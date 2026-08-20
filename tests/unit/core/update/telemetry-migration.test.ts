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
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';

import * as configConstants from '@/core/config-constants.ts';
import { DISTRIBUTION } from '@/core/host/distribution.ts';
import type { CliState, StoredCommandExecutedEvent } from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import * as telemetryEvents from '@/core/telemetry/telemetry-events.ts';
import { migrateLegacyTelemetryEvents } from '@/core/update/telemetry-migration.ts';

function makeState(): CliState {
  return getDefaultState('1.0.0');
}

function makeLegacyCommandEvent(command: string): StoredCommandExecutedEvent {
  return {
    metadata: {
      event_id: randomUUID(),
      source: { domain: 'CLI' },
      event_type: 'Analytics.Cli.CliCommandExecuted',
      event_timestamp: String(Date.now()),
    },
    event_payload: {
      cli_installation_id: 'install-id',
      machine_id: 'machine-id',
      cli_version: '1.0.0',
      invocation_id: 'inv-id',
      os: 'linux',
      connection_type: null,
      user_uuid: null,
      organization_uuid_v4: null,
      sqs_installation_id: null,
      caller_agent: null,
      agent_session_id: null,
      command,
      subcommand: null,
      result: 'success',
      distribution: DISTRIBUTION,
      project_uuid: null,
    },
  };
}

describe('migrateLegacyTelemetryEvents', () => {
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let saveStateSpy: Mock<typeof stateRepository.saveState>;
  let appendTelemetryEventSpy: Mock<typeof telemetryEvents.appendTelemetryEvent>;
  let getTelemetryDirSpy: Mock<typeof configConstants.getTelemetryDir>;
  let telemetryDir: string;

  beforeEach(() => {
    telemetryDir = fs.mkdtempSync(join(tmpdir(), 'cli-post-update-telemetry-'));
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeState());
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {});
    appendTelemetryEventSpy = spyOn(telemetryEvents, 'appendTelemetryEvent').mockImplementation(
      () => {},
    );
    getTelemetryDirSpy = spyOn(configConstants, 'getTelemetryDir').mockReturnValue(telemetryDir);
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    appendTelemetryEventSpy.mockRestore();
    getTelemetryDirSpy.mockRestore();
    fs.rmSync(telemetryDir, { recursive: true, force: true });
  });

  it('does nothing when there are no legacy telemetry events', () => {
    // Default state has no telemetry.events queue.
    migrateLegacyTelemetryEvents();

    expect(appendTelemetryEventSpy).not.toHaveBeenCalled();
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  it('migrates each legacy event to telemetry-events.ndjson and clears the queue', () => {
    const state = makeState();
    const events = [makeLegacyCommandEvent('auth'), makeLegacyCommandEvent('analyze')];
    state.telemetry.events = events;
    loadStateSpy.mockReturnValue(state);

    migrateLegacyTelemetryEvents();

    expect(appendTelemetryEventSpy).toHaveBeenCalledTimes(2);
    expect(appendTelemetryEventSpy).toHaveBeenNthCalledWith(1, events[0]);
    expect(appendTelemetryEventSpy).toHaveBeenNthCalledWith(2, events[1]);

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    expect(saveStateSpy.mock.calls[0][0].telemetry.events).toBeUndefined();
  });

  it('renames the on-disk findings.ndjson sink to telemetry-events.ndjson', () => {
    const oldPath = join(telemetryDir, 'findings.ndjson');
    const newPath = join(telemetryDir, 'telemetry-events.ndjson');
    fs.writeFileSync(oldPath, '{"event":"buffered"}\n');

    migrateLegacyTelemetryEvents();

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.readFileSync(newPath, 'utf-8')).toBe('{"event":"buffered"}\n');
  });

  it('appends the old sink contents when telemetry-events.ndjson already exists', () => {
    const oldPath = join(telemetryDir, 'findings.ndjson');
    const newPath = join(telemetryDir, 'telemetry-events.ndjson');
    fs.writeFileSync(newPath, '{"event":"existing"}\n');
    fs.writeFileSync(oldPath, '{"event":"buffered"}\n');

    migrateLegacyTelemetryEvents();

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.readFileSync(newPath, 'utf-8')).toBe('{"event":"existing"}\n{"event":"buffered"}\n');
  });
});
