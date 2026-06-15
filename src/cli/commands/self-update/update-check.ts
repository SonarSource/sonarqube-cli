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

import { version as CURRENT_VERSION } from '../../../../package.json';
import { UPDATE_SCRIPT_BASE_URL } from '../../../lib/config-constants';
import { isWindows } from '../../../lib/platform-detector';
import { isNewerVersion, stripBuildNumber } from '../../../lib/version';
import { CommandFailedError } from '../_common/error';

const UPDATE_CHECK_TIMEOUT_MS = 5000;
const VERSION_PATTERNS = [
  // Shell:       version="1.2.3"  or  version='1.2.3'
  /\bversion\s*=\s*["'](\d+\.\d+\.\d+(?:\.\d+)?)["']/,
  // PowerShell:  $SonarVersion = "1.2.3"
  /\$SonarVersion\s*=\s*["'](\d+\.\d+\.\d+(?:\.\d+)?)["']/i,
];

/** Extract the pinned version from an install script. Returns null if not found. */
export function extractVersion(scriptContent: string): string | null {
  for (const pattern of VERSION_PATTERNS) {
    const match = pattern.exec(scriptContent);
    if (match) return match[1];
  }
  return null;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  /** Downloaded script content — reuse in selfUpdate() to avoid a second fetch. */
  scriptContent: string;
  /** Platform-appropriate script filename ('install.sh' or 'install.ps1'). */
  scriptName: string;
}

/**
 * Fetches the install script from GitHub and returns version comparison data.
 * Throws on network failure or when the version cannot be extracted from the script.
 */
export async function checkForUpdate(baseUrl?: string): Promise<UpdateCheckResult> {
  const scriptName = isWindows() ? 'install.ps1' : 'install.sh';
  const scriptUrl = `${baseUrl ?? UPDATE_SCRIPT_BASE_URL}/${scriptName}`;

  const response = await fetch(scriptUrl, { signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) });
  if (!response.ok) {
    throw new CommandFailedError(`Failed to fetch update script: HTTP ${response.status}`, {
      remediationHint: 'Check network access and retry.',
    });
  }

  const scriptContent = await response.text();
  const latestVersion = extractVersion(scriptContent);
  if (latestVersion === null) {
    throw new CommandFailedError(
      'Could not determine the latest version from the install script.',
      { remediationHint: 'Retry later or update manually using the installer script.' },
    );
  }

  return {
    currentVersion: CURRENT_VERSION,
    latestVersion,
    updateAvailable: isNewerVersion(CURRENT_VERSION, stripBuildNumber(latestVersion)),
    scriptContent,
    scriptName,
  };
}
