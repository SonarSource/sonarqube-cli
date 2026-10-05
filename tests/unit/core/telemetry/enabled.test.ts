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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { setConfigFileValue } from '@/core/config/config-file.ts';
import { ENV_DO_NOT_TRACK, ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { isDoNotTrackRequested, isTelemetryEnabled } from '@/core/telemetry/enabled.ts';

import { restoreEnv } from '../../../_common/isolated-cli-env.ts';

// Each test runs from an unset baseline; restore the preload's DO_NOT_TRACK afterwards
// so we don't leak a cleared value that would re-enable telemetry for later tests.
const PRELOAD_DO_NOT_TRACK = process.env[ENV_DO_NOT_TRACK];
let savedSonarUserHome: string | undefined;
let testDir: string;

beforeEach(() => {
  delete process.env[ENV_DO_NOT_TRACK];
  savedSonarUserHome = process.env[ENV_SONAR_USER_HOME];
  testDir = mkdtempSync(join(tmpdir(), 'telemetry-enabled-test-'));
  process.env[ENV_SONAR_USER_HOME] = testDir;
});

afterEach(() => {
  restoreEnv(ENV_DO_NOT_TRACK, PRELOAD_DO_NOT_TRACK);
  restoreEnv(ENV_SONAR_USER_HOME, savedSonarUserHome);
  rmSync(testDir, { recursive: true, force: true });
});

describe('isDoNotTrackRequested', () => {
  it('returns true when set to 1', () => {
    process.env[ENV_DO_NOT_TRACK] = '1';
    expect(isDoNotTrackRequested()).toBe(true);
  });

  it('returns true when set to 1 with surrounding whitespace', () => {
    process.env[ENV_DO_NOT_TRACK] = ' 1 ';
    expect(isDoNotTrackRequested()).toBe(true);
  });

  it.each(['0', 'yes', 'true', ''])('returns false for %s', (value) => {
    process.env[ENV_DO_NOT_TRACK] = value;
    expect(isDoNotTrackRequested()).toBe(false);
  });

  it('returns false when unset', () => {
    expect(isDoNotTrackRequested()).toBe(false);
  });
});

describe('isTelemetryEnabled', () => {
  it('returns true when unset in config and DO_NOT_TRACK is unset', () => {
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('returns true when enabled in config', () => {
    setConfigFileValue('telemetry.enabled', 'true');

    expect(isTelemetryEnabled()).toBe(true);
  });

  it('returns false when disabled in config', () => {
    setConfigFileValue('telemetry.enabled', 'false');

    expect(isTelemetryEnabled()).toBe(false);
  });

  it('returns false when DO_NOT_TRACK is set even if enabled in config', () => {
    setConfigFileValue('telemetry.enabled', 'true');
    process.env[ENV_DO_NOT_TRACK] = '1';

    expect(isTelemetryEnabled()).toBe(false);
  });
});
