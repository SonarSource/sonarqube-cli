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

import { version as VERSION } from '../../package.json';
import { ApiCallError } from './errors';
import { isNewerVersion } from './version';

const FETCH_TIMEOUT_MS = 2000;

// Matches the leading numeric portion of a version string (digits and dots), ending on a digit.
// "2026.3.0.121998" → "2026.3.0.121998", "26.2-SNAPSHOT" → "26.2", "2026.2.SNAPSHOT" → "2026.2"
const LEADING_NUMERIC_VERSION = /^[\d.]*\d/;

function hasFullYearPrefix(version: string): boolean {
  return version.indexOf('.') === 4;
}

/**
 * Normalizes a SonarQube Server version to short-year form.
 * "2026.2" → "26.2", "26.2" stays as-is.
 */
export function normalizeVersion(version: string): string {
  const numeric = LEADING_NUMERIC_VERSION.exec(version)?.[0] ?? version;
  return hasFullYearPrefix(numeric) ? numeric.slice(2) : numeric;
}

/**
 * Returns true if serverVersion >= minVersion.
 * Both versions are normalized to short-year form before comparison.
 */
export function isAtLeast(serverVersion: string | undefined, minVersion: string): boolean {
  if (!serverVersion) return false;
  const normalizedServer = normalizeVersion(serverVersion);
  const normalizedMin = normalizeVersion(minVersion);
  // isNewerVersion(a, b) returns true when b > a
  // We want serverVersion >= minVersion, i.e. minVersion is NOT newer than serverVersion
  return !isNewerVersion(normalizedServer, normalizedMin);
}

/**
 * Fetches the server version from the public /api/system/status endpoint.
 * Throws if the server is unreachable or returns an error.
 */
export async function fetchServerVersion(serverURL: string): Promise<string> {
  const cleanURL = serverURL.replace(/\/$/, '');
  const url = `${cleanURL}/api/system/status`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': `sonarqube-cli/${VERSION}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ApiCallError(`Server returned HTTP ${response.status} for ${url}`);
  }
  const data = (await response.json()) as { version?: string };
  if (!data.version) {
    throw new ApiCallError(`Server did not return a version in ${url}`);
  }
  return data.version;
}
