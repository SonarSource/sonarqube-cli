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

/** Default env for spawned CLI processes in tests. */

import { ENV_DO_NOT_TRACK } from '@/core/config-constants.ts';
import { ENV_TELEMETRY_EGRESS, TELEMETRY_EGRESS_OFF } from '@/core/telemetry/egress.ts';

/**
 * Both switches are needed: a test asserting on telemetry must re-enable consent
 * (DO_NOT_TRACK), so only the egress mode keeps its fixtures off the production backend.
 */
export const ISOLATED_CLI_SPAWN_ENV: Record<string, string> = {
  [ENV_DO_NOT_TRACK]: '1',
  [ENV_TELEMETRY_EGRESS]: TELEMETRY_EGRESS_OFF,
};

/**
 * Overlay the isolation defaults on a spawn environment. Isolation wins over caller-supplied
 * values, except that a test may set DO_NOT_TRACK=0 to exercise the telemetry pipeline.
 */
export function applyIsolatedSpawnEnv(env: Record<string, string>): Record<string, string> {
  const spawnEnv: Record<string, string> = { ...env, ...ISOLATED_CLI_SPAWN_ENV };

  if (env[ENV_DO_NOT_TRACK] === '0') {
    spawnEnv[ENV_DO_NOT_TRACK] = '0';
  }

  if (spawnEnv[ENV_TELEMETRY_EGRESS] !== TELEMETRY_EGRESS_OFF) {
    throw new Error(
      `Test isolation broken: ${ENV_TELEMETRY_EGRESS} must be "${TELEMETRY_EGRESS_OFF}" for ` +
        `spawned CLIs, got "${spawnEnv[ENV_TELEMETRY_EGRESS] ?? '<unset>'}".`,
    );
  }

  return spawnEnv;
}

/** Restore an env var to a captured value, deleting it when the value was unset. */
export function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = previous;
  }
}
