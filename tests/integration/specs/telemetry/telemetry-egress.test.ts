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

// Pins the property every other telemetry spec depends on: with egress off, events are
// queued and never drained.
//
// A retained queue stands in for "no worker ran" because absence of a detached grandchild is
// not assertable without scanning the process table; a worker that ran would have renamed
// the queue away.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ENV_TELEMETRY_EGRESS, TELEMETRY_EGRESS_OFF } from '@/core/telemetry/egress.ts';

import { readCommandEvents } from '../../../_common/telemetry-helpers.ts';
import { TestHarness } from '../../harness';

const VALID_TOKEN = 'squ_valid_token';

function telemetryDirEntries(sonarUserHome: string): string[] {
  try {
    return readdirSync(join(sonarUserHome, 'sonarqube-cli', 'telemetry'));
  } catch {
    return [];
  }
}

describe('telemetry egress isolation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('pins egress off for every spawned CLI', () => {
    expect(harness.env()[ENV_TELEMETRY_EGRESS]).toBe(TELEMETRY_EGRESS_OFF);
  });

  it('keeps egress off even when a spec re-enables the telemetry pipeline', () => {
    harness.state().withTelemetryEnabled();

    expect(harness.env()[ENV_TELEMETRY_EGRESS]).toBe(TELEMETRY_EGRESS_OFF);
  });

  it('queues the event on disk and never drains it', async () => {
    const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
    harness.state().withTelemetryEnabled();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('system status');
    expect(result.exitCode).toBe(0);

    // Non-empty first, so the assertions below are not vacuous.
    expect(readCommandEvents(harness.sonarUserHome.path).length).toBeGreaterThan(0);

    // A drain is asynchronous to CLI exit, so re-check after a delay it could have used.
    await Bun.sleep(1_500);
    expect(readCommandEvents(harness.sonarUserHome.path).length).toBeGreaterThan(0);
    expect(
      telemetryDirEntries(harness.sonarUserHome.path).filter((f) => f.includes('.sending')),
    ).toEqual([]);
  });
});
