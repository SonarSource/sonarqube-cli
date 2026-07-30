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

// SonarCloud region/URL helpers - pure, dependency-free (avoids a cycle between auth-resolver.ts and identity-fetch.ts).

import {
  SONARCLOUD_API_URL,
  SONARCLOUD_HOSTNAME,
  SONARCLOUD_URL,
  SONARCLOUD_US_API_URL,
  SONARCLOUD_US_HOSTNAME,
  SONARCLOUD_US_URL,
} from '../config-constants.ts';
import type { CloudRegion } from '../state/state.ts';

export function cloudRegionFromUrl(serverUrl: string): CloudRegion | undefined {
  try {
    const { hostname } = new URL(serverUrl);
    if (hostname === SONARCLOUD_US_HOSTNAME) return 'us';
    if (hostname === SONARCLOUD_HOSTNAME) return 'eu';
    return undefined;
  } catch {
    return undefined;
  }
}

export function isSonarQubeCloud(serverUrl: string): boolean {
  return cloudRegionFromUrl(serverUrl) !== undefined;
}

/**
 * Determine the base URL for a request based on its endpoint.
 * SonarCloud uses separate hosts:
 * - sonarcloud.io for /api/... endpoints
 * - api.sonarcloud.io for all other endpoints
 */
export function resolveFromEndpoint(serverUrl: string, endpoint: string): string {
  const normalized = serverUrl.replace(/\/$/, '');
  const region = cloudRegionFromUrl(serverUrl);
  if (region !== undefined) {
    const isUS = region === 'us';

    if (endpoint.startsWith('/api')) {
      return isUS ? SONARCLOUD_US_URL : SONARCLOUD_URL;
    }

    return isUS ? SONARCLOUD_US_API_URL : SONARCLOUD_API_URL;
  }
  return normalized;
}

const SERVER_V2_PREFIX = '/api/v2';

/**
 * SonarQube Server's V2 API paths (`/api/v2/...`) have no equivalent under that
 * prefix on SonarCloud: the same functionality lives at the API host without it
 * (e.g. Server's `/api/v2/sca/issues-releases` is SonarCloud's `/sca/issues-releases`).
 * A request with that prefix 404s or 403s on SonarCloud regardless of host, so
 * stripping it is always correct there. Only relevant for `sonar api`'s free-form
 * endpoint — every other caller already picks the right path per connection type.
 */
export function normalizeCloudV2Endpoint(serverUrl: string, endpoint: string): string {
  if (isSonarQubeCloud(serverUrl) && endpoint.startsWith(`${SERVER_V2_PREFIX}/`)) {
    return endpoint.slice(SERVER_V2_PREFIX.length);
  }
  return endpoint;
}
