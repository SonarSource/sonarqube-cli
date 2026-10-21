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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getDefaultState } from '@/core/state/state.ts';

import { POST_UPDATE_TRIGGER_COMMAND } from '../../../_common/isolated-cli-env.js';
import { TestHarness } from '../../harness';

describe('legacy telemetry queue migration', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('drains events and keeps the saved queue compatible with an old process', async () => {
    const state = getDefaultState('0.5.0');
    const events = [{ legacy: 'first' }, { legacy: 'second' }];
    harness.state().withRawState(
      JSON.stringify({
        ...state,
        telemetry: { ...state.telemetry, events },
      }),
    );

    const migrated = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

    expect(migrated.exitCode).toBe(0);
    expect(harness.stateJsonFile.asJson().telemetry.events).toEqual([]);
    const sink = harness.cliHome.file('telemetry', 'telemetry-events.ndjson');
    expect(
      sink
        .asText()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual(events);

    const beforeSave = harness.stateJsonFile.asJson();
    beforeSave.config.cliVersion = '0.5.0';
    harness.state().withRawState(JSON.stringify(beforeSave));
    const savedAgain = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

    expect(savedAgain.exitCode).toBe(0);
    const reloaded = harness.stateJsonFile.asJson();
    expect(reloaded.config.cliVersion).not.toBe('0.5.0');
    expect(reloaded.telemetry.events).toEqual([]);
    expect(() => {
      reloaded.telemetry.events.push(events[0]);
    }).not.toThrow();
    expect(reloaded.telemetry.events).toEqual([events[0]]);
    expect(
      sink
        .asText()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual(events);
  });
});
