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

import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  APP_NAME,
  ENV_SONAR_USER_HOME,
  ENV_SQAA_RETRY_BASE_DELAY_MS,
  getCliDir,
  getSonarUserHome,
  getSqaaRetry503BaseDelayMs,
  getTelemetryDir,
  LOG_DIR,
  LOG_FILE,
} from '@/core/config-constants.ts';

describe('config-constants', () => {
  const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];

  afterEach(() => {
    if (previousSonarUserHome === undefined) {
      delete process.env[ENV_SONAR_USER_HOME];
    } else {
      process.env[ENV_SONAR_USER_HOME] = previousSonarUserHome;
    }
  });

  it('LOG_FILE should be inside LOG_DIR', () => {
    expect(LOG_FILE.startsWith(LOG_DIR)).toBe(true);
  });

  it('LOG_FILE should have the correct filename', () => {
    expect(LOG_FILE).toBe(join(LOG_DIR, `${APP_NAME}.log`));
  });

  describe('path resolution', () => {
    it('defaults SONAR_USER_HOME to ~/.sonar when unset', () => {
      delete process.env[ENV_SONAR_USER_HOME];

      expect(getSonarUserHome()).toBe(join(homedir(), '.sonar'));
    });

    it('derives the CLI dir from SONAR_USER_HOME', () => {
      process.env[ENV_SONAR_USER_HOME] = '/tmp/sonar-home';

      expect(getCliDir()).toBe(join('/tmp/sonar-home', 'sonarqube-cli'));
    });

    it('keeps the CLI storage dir stable', () => {
      expect(basename(getCliDir())).toBe('sonarqube-cli');
    });

    it('getTelemetryDir is nested inside the CLI dir', () => {
      process.env[ENV_SONAR_USER_HOME] = '/tmp/sonar-home';

      expect(getTelemetryDir()).toBe(join(getCliDir(), 'telemetry'));
    });
  });

  describe('getSqaaRetry503BaseDelayMs', () => {
    const previous = process.env[ENV_SQAA_RETRY_BASE_DELAY_MS];

    afterEach(() => {
      if (previous === undefined) {
        delete process.env[ENV_SQAA_RETRY_BASE_DELAY_MS];
      } else {
        process.env[ENV_SQAA_RETRY_BASE_DELAY_MS] = previous;
      }
    });

    it('defaults to 2000ms when unset', () => {
      delete process.env[ENV_SQAA_RETRY_BASE_DELAY_MS];
      expect(getSqaaRetry503BaseDelayMs()).toBe(2000);
    });

    it('uses the env override when valid', () => {
      process.env[ENV_SQAA_RETRY_BASE_DELAY_MS] = '0';
      expect(getSqaaRetry503BaseDelayMs()).toBe(0);
    });

    it('falls back to 2000ms for invalid values', () => {
      process.env[ENV_SQAA_RETRY_BASE_DELAY_MS] = 'not-a-number';
      expect(getSqaaRetry503BaseDelayMs()).toBe(2000);
    });
  });
});
