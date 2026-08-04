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

import { ENV_DO_NOT_TRACK } from '@/core/config-constants.ts';
import {
  ENV_TELEMETRY_EGRESS,
  resolveTelemetryEgress,
  TELEMETRY_EGRESS_OFF,
} from '@/core/telemetry/egress.ts';

import {
  applyIsolatedSpawnEnv,
  ISOLATED_CLI_SPAWN_ENV,
  restoreEnv,
} from '../../../_common/isolated-cli-env.ts';

let savedEgress: string | undefined;

beforeEach(() => {
  savedEgress = process.env[ENV_TELEMETRY_EGRESS];
});

afterEach(() => {
  restoreEnv(ENV_TELEMETRY_EGRESS, savedEgress);
});

describe('resolveTelemetryEgress()', () => {
  it('is production when the variable is unset', () => {
    delete process.env[ENV_TELEMETRY_EGRESS];
    expect(resolveTelemetryEgress().kind).toBe('production');
  });

  it('is production when the variable is empty or whitespace', () => {
    process.env[ENV_TELEMETRY_EGRESS] = '   ';
    expect(resolveTelemetryEgress().kind).toBe('production');
  });

  it('is off for the canonical value', () => {
    process.env[ENV_TELEMETRY_EGRESS] = TELEMETRY_EGRESS_OFF;
    expect(resolveTelemetryEgress().kind).toBe('off');
  });

  it.each([['of'], ['Off'], ['OFF'], ['0'], ['false'], ['disabled'], ['http://127.0.0.1:9']])(
    'is off for the unrecognised value %p',
    (value) => {
      process.env[ENV_TELEMETRY_EGRESS] = value;
      expect(resolveTelemetryEgress().kind).toBe('off');
    },
  );

  it('is not memoized across calls', () => {
    delete process.env[ENV_TELEMETRY_EGRESS];
    expect(resolveTelemetryEgress().kind).toBe('production');
    process.env[ENV_TELEMETRY_EGRESS] = TELEMETRY_EGRESS_OFF;
    expect(resolveTelemetryEgress().kind).toBe('off');
  });
});

describe('test isolation defaults', () => {
  it('severs egress for every spawned CLI', () => {
    expect(ISOLATED_CLI_SPAWN_ENV[ENV_TELEMETRY_EGRESS]).toBe(TELEMETRY_EGRESS_OFF);
  });

  it('keeps egress off even when a test re-enables the telemetry pipeline', () => {
    const env = applyIsolatedSpawnEnv({ [ENV_DO_NOT_TRACK]: '0' });

    expect(env[ENV_DO_NOT_TRACK]).toBe('0');
    expect(env[ENV_TELEMETRY_EGRESS]).toBe(TELEMETRY_EGRESS_OFF);
  });

  it('refuses a caller-supplied egress override', () => {
    const env = applyIsolatedSpawnEnv({ [ENV_TELEMETRY_EGRESS]: 'production' });

    expect(env[ENV_TELEMETRY_EGRESS]).toBe(TELEMETRY_EGRESS_OFF);
  });
});
