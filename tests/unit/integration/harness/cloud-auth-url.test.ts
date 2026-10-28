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

import { describe, expect, it } from 'bun:test';

import {
  applyLoopbackSonarCloudEnvOverrides,
  isLoopbackTestServerUrl,
} from '../../../integration/harness/cloud-auth-url.js';

describe('cloud-auth-url harness helpers', () => {
  it('detects loopback server URLs', () => {
    expect(isLoopbackTestServerUrl('http://localhost:9000')).toBe(true);
    expect(isLoopbackTestServerUrl('http://127.0.0.1:9000')).toBe(true);
    expect(isLoopbackTestServerUrl('https://sonarcloud.io')).toBe(false);
  });

  it('injects SonarCloud env overrides for loopback EU cloud auth', () => {
    const env: Record<string, string> = {};
    applyLoopbackSonarCloudEnvOverrides(env, 'http://localhost:9000', 'eu');
    expect(env.SONARQUBE_CLI_SONARCLOUD_URL).toBe('http://localhost:9000');
    expect(env.SONARQUBE_CLI_SONARCLOUD_API_URL).toBe('http://localhost:9000');
  });

  it('injects SonarCloud env overrides for loopback US cloud auth', () => {
    const env: Record<string, string> = {};
    applyLoopbackSonarCloudEnvOverrides(env, 'http://127.0.0.1:9000', 'us');
    expect(env.SONARQUBE_CLI_SONARCLOUD_US_URL).toBe('http://127.0.0.1:9000');
    expect(env.SONARQUBE_CLI_SONARCLOUD_US_API_URL).toBe('http://127.0.0.1:9000');
  });
});
