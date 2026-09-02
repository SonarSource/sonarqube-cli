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

// Reads the published stable CLI version from binaries.sonarsource.com. Used by
// both `sonar update` (commands/update/update-check.ts, for the foreground
// version check) and the background update-notification check in
// core/update/notification.ts.

import { CommandFailedError } from '@/core/command-error.ts';
import { CLI_STABLE_VERSION_PATH, SONARSOURCE_BINARIES_URL } from '@/core/config-constants.ts';
import { fetchAnonymous } from '@/core/server/fetch.ts';

const UPDATE_CHECK_TIMEOUT_MS = 5000;
/** Best-effort background fetch after eligible commands — fail fast to avoid blocking UX. */
export const BACKGROUND_UPDATE_CHECK_TIMEOUT_MS = 1500;
const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:\.\d+)?$/;

export async function fetchText(
  url: string,
  description: string,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
): Promise<string> {
  const response = await fetchAnonymous(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new CommandFailedError(`Failed to fetch ${description}: HTTP ${response.status}`, {
      remediationHint: 'Check network access and retry.',
    });
  }
  return response.text();
}

function parseStableVersion(raw: string): string | null {
  const latestVersion = raw.trim();
  return STABLE_VERSION_PATTERN.test(latestVersion) ? latestVersion : null;
}

/**
 * Reads the published stable.version string from binaries.sonarsource.com.
 */
export async function fetchLatestVersion(timeoutMs = UPDATE_CHECK_TIMEOUT_MS): Promise<string> {
  const stableVersionUrl = `${SONARSOURCE_BINARIES_URL}/${CLI_STABLE_VERSION_PATH}`;
  const body = await fetchText(stableVersionUrl, 'stable version', timeoutMs);
  const version = parseStableVersion(body);
  if (!version) {
    throw new CommandFailedError('Could not determine the latest version.', {
      remediationHint: 'Retry later or update manually using the installer script.',
    });
  }
  return version;
}
