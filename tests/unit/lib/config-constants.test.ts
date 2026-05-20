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

import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  APP_NAME,
  ENV_SQAA_RETRY_BASE_DELAY_MS,
  getSqaaRetry503BaseDelayMs,
  LOG_DIR,
  LOG_FILE,
} from '../../../src/lib/config-constants';

describe('config-constants', () => {
  it('LOG_FILE should be inside LOG_DIR', () => {
    expect(LOG_FILE.startsWith(LOG_DIR)).toBe(true);
  });

  it('LOG_FILE should have the correct filename', () => {
    expect(LOG_FILE).toBe(join(LOG_DIR, `${APP_NAME}.log`));
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
