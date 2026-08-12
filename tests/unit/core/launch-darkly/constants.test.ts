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

import { afterEach, describe, expect, it } from 'bun:test';

import {
  ENV_LAUNCHDARKLY_ENVIRONMENT,
  getLaunchDarklyDir,
  LAUNCHDARKLY_CLIENT_SIDE_IDS,
  resolveLaunchDarklyClientSideId,
  resolveLaunchDarklyEnvironment,
} from '@/core/launch-darkly/constants.ts';

describe('resolveLaunchDarklyEnvironment', () => {
  afterEach(() => {
    delete process.env[ENV_LAUNCHDARKLY_ENVIRONMENT];
  });

  it('defaults to production when the env var is unset', () => {
    expect(resolveLaunchDarklyEnvironment({})).toBe('production');
  });

  it('selects dev when SONARQUBE_CLI_LAUNCHDARKLY_ENV=dev', () => {
    expect(resolveLaunchDarklyEnvironment({ [ENV_LAUNCHDARKLY_ENVIRONMENT]: 'dev' })).toBe('dev');
  });

  it('is case-insensitive for dev', () => {
    expect(resolveLaunchDarklyEnvironment({ [ENV_LAUNCHDARKLY_ENVIRONMENT]: 'DEV' })).toBe('dev');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(resolveLaunchDarklyEnvironment({ [ENV_LAUNCHDARKLY_ENVIRONMENT]: '  Dev  ' })).toBe(
      'dev',
    );
  });

  it('falls back to production for unrecognized values', () => {
    expect(resolveLaunchDarklyEnvironment({ [ENV_LAUNCHDARKLY_ENVIRONMENT]: 'staging' })).toBe(
      'production',
    );
  });
});

describe('resolveLaunchDarklyClientSideId', () => {
  it('returns the client-side ID for the selected environment', () => {
    expect(resolveLaunchDarklyClientSideId({})).toBe(LAUNCHDARKLY_CLIENT_SIDE_IDS.production);
    expect(resolveLaunchDarklyClientSideId({ [ENV_LAUNCHDARKLY_ENVIRONMENT]: 'dev' })).toBe(
      LAUNCHDARKLY_CLIENT_SIDE_IDS.dev,
    );
  });
});

describe('getLaunchDarklyDir', () => {
  it('resolves under SONAR_USER_HOME/sonarqube-cli/launch-darkly', () => {
    const previous = process.env.SONAR_USER_HOME;
    const tempHome = mkdtempSync(join(tmpdir(), 'sqcli-ld-dir-'));
    process.env.SONAR_USER_HOME = tempHome;
    try {
      expect(getLaunchDarklyDir()).toBe(join(tempHome, 'sonarqube-cli', 'launch-darkly'));
    } finally {
      if (previous === undefined) {
        delete process.env.SONAR_USER_HOME;
      } else {
        process.env.SONAR_USER_HOME = previous;
      }
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
