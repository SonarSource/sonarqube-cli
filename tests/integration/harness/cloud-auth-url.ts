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

/** Canonical SonarQube Cloud host URLs (e.g. fake-server region hints). */

export const RECORDED_SONARCLOUD_EU_URL = 'https://sonarcloud.io';
export const RECORDED_SONARCLOUD_US_URL = 'https://sonarqube.us';

export type RecordedCloudRegion = 'eu' | 'us';

export function isLoopbackTestServerUrl(serverUrl: string): boolean {
  try {
    const { hostname } = new URL(serverUrl);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export function inferRecordedCloudRegion(env: Record<string, string>): RecordedCloudRegion {
  if (env.SONARQUBE_CLI_SONARCLOUD_US_URL || env.SONARQUBE_CLI_SONARCLOUD_US_API_URL) {
    return 'us';
  }
  return 'eu';
}

export function recordedCloudAuthServerUrl(region: RecordedCloudRegion = 'eu'): string {
  return region === 'us' ? RECORDED_SONARCLOUD_US_URL : RECORDED_SONARCLOUD_EU_URL;
}

/** Makes loopback URLs resolvable as SonarCloud inside the compiled CLI under test. */
export function applyLoopbackSonarCloudEnvOverrides(
  target: Record<string, string>,
  serverUrl: string,
  region: RecordedCloudRegion = 'eu',
): void {
  if (!isLoopbackTestServerUrl(serverUrl)) {
    return;
  }
  if (region === 'us') {
    target.SONARQUBE_CLI_SONARCLOUD_US_URL = serverUrl;
    target.SONARQUBE_CLI_SONARCLOUD_US_API_URL = serverUrl;
  } else {
    target.SONARQUBE_CLI_SONARCLOUD_URL = serverUrl;
    target.SONARQUBE_CLI_SONARCLOUD_API_URL = serverUrl;
  }
}
