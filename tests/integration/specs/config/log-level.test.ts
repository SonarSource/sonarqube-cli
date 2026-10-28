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

// Integration tests for applying the stored `log.level` config at startup.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getDefaultState } from '@/core/state/state.ts';

import { POST_UPDATE_TRIGGER_COMMAND } from '../../../_common/isolated-cli-env.js';
import { TestHarness } from '../../harness';

// A stale cliVersion makes every run log "Running post-update actions" at DEBUG level.
const DEBUG_LINE = '[DEBUG] Running post-update actions';

describe('stored log.level', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withRawState(JSON.stringify(getDefaultState('0.5.0')));
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function storeLogLevel(level: string): void {
    harness.cliHome.writeFile('cli-config.properties', `log.level=${level}\n`);
  }

  function logFileText(): string {
    const logFile = harness.cliHome.file('logs', 'sonarqube-cli.log');
    return logFile.exists() ? logFile.asText() : '';
  }

  it(
    'sets the log level when the LOG_LEVEL env var is not set',
    async () => {
      storeLogLevel('DEBUG');

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      expect(logFileText()).toContain(DEBUG_LINE);
    },
    { timeout: 15000 },
  );

  it(
    'is overridden by the LOG_LEVEL env var',
    async () => {
      storeLogLevel('DEBUG');

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND, {
        extraEnv: { LOG_LEVEL: 'INFO' },
      });

      expect(result.exitCode).toBe(0);
      expect(logFileText()).not.toContain(DEBUG_LINE);
    },
    { timeout: 15000 },
  );

  it(
    'keeps the default level when not stored',
    async () => {
      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      // Default level is INFO.
      expect(logFileText()).not.toContain(DEBUG_LINE);
    },
    { timeout: 15000 },
  );
});
