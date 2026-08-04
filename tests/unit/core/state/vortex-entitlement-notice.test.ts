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

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { loadState, saveState } from '@/core/state/state-manager.ts';
import { ONE_DAY_MS } from '@/core/time/cooldown.ts';
import {
  isVortexEntitlementLossNoticeDue,
  recordVortexEntitlementLossWarned,
} from '@/core/vortex/vortex-entitlement-notice.ts';

const testSonarUserHome = join(tmpdir(), `sonar-cli-vortex-notice-test-${Date.now()}`);
const testCliDir = join(testSonarUserHome, 'sonarqube-cli');

process.env.SONAR_USER_HOME = testSonarUserHome;

function cleanup(): void {
  if (existsSync(testCliDir)) {
    rmSync(testCliDir, { recursive: true, force: true });
  }
}

function seedLastWarnedAt(iso: string): void {
  const state = loadState();
  state.config.vortexEntitlementLossNotice = { lastWarnedAt: iso };
  saveState(state);
}

describe('Vortex entitlement-loss notice throttle', () => {
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(() => {
    delete process.env.SONAR_USER_HOME;
  });

  it('is due when no state file exists yet', () => {
    expect(isVortexEntitlementLossNoticeDue()).toBe(true);
  });

  it('is due when the last warning is older than the cooldown', () => {
    seedLastWarnedAt(new Date(Date.now() - 2 * ONE_DAY_MS).toISOString());

    expect(isVortexEntitlementLossNoticeDue()).toBe(true);
  });

  it('is not due when a warning was emitted within the cooldown', () => {
    seedLastWarnedAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());

    expect(isVortexEntitlementLossNoticeDue()).toBe(false);
  });

  it('records the warning and suppresses the next check', () => {
    recordVortexEntitlementLossWarned();

    const state = loadState();
    expect(state.config.vortexEntitlementLossNotice?.lastWarnedAt).toBeDefined();
    expect(isVortexEntitlementLossNoticeDue()).toBe(false);
  });
});
