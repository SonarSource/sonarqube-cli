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

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { version as CURRENT_VERSION } from '../../../package.json';
import {
  CLI_STABLE_VERSION_PATH,
  SONARSOURCE_BINARIES_URL,
  UPDATE_SCRIPT_BASE_URL,
} from '../../lib/config-constants.ts';
import { buildFetchNetworkOptions } from '../../lib/connectivity/network-config.ts';
import { isWindows } from '../../lib/platform-detector.ts';
import { CommandFailedError } from '../_common/error.ts';
import { Version } from '../_common/version.ts';

const UPDATE_CHECK_TIMEOUT_MS = 5000;
/** Best-effort background fetch after eligible commands — fail fast to avoid blocking UX. */
export const BACKGROUND_UPDATE_CHECK_TIMEOUT_MS = 1500;
const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
const TEMP_SCRIPT_PREFIX = 'sonar-update-';
const TEMP_SCRIPT_CREATE_ATTEMPTS = 5;

type UpdateInstallResult =
  | { status: 'installed' }
  | { status: 'launched_in_new_terminal' }
  | { status: 'failed'; scriptExitStatus: number | null; scriptErrorMessage?: string };

export class Update {
  constructor(readonly version: Version) {}

  async install(): Promise<UpdateInstallResult> {
    const { scriptContent, scriptName } = await this.fetchUpdateScript();
    const tempPath = this.writeTempScript(scriptName, scriptContent);

    if (isWindows()) {
      // On Windows the running binary is file-locked, so the parent must exit immediately
      // so that the script can overwrite the executable. Otherwise, the update will fail and
      // has to be manually retried by the user.
      // Open PowerShell in a new window so it has its own console and the user can see the output.
      // Run the installer in a nested PowerShell process so the outer window can
      // always remove the temporary script afterwards, even if the installer exits.
      const escapedTempPath = tempPath.replaceAll("'", "''");
      const cleanupCommand =
        `& powershell -ExecutionPolicy Bypass -File '${escapedTempPath}'; ` +
        `Remove-Item -Force '${escapedTempPath}' -ErrorAction SilentlyContinue`;
      // The ComSpec environment variable always points to the system cmd.exe.
      const cmdExe = process.env.ComSpec ?? String.raw`C:\Windows\System32\cmd.exe`;
      try {
        const child = spawn(
          cmdExe,
          [
            '/c',
            'start',
            'powershell',
            '-NoExit',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            cleanupCommand,
          ],
          { detached: true, stdio: 'ignore' },
        );

        return await new Promise<UpdateInstallResult>((resolve) => {
          child.once('spawn', () => {
            child.unref();
            resolve({ status: 'launched_in_new_terminal' });
          });
          child.once('error', (error) => {
            rmSync(tempPath, { force: true });
            resolve({
              status: 'failed',
              scriptExitStatus: null,
              scriptErrorMessage: error.message,
            });
          });
        });
      } catch (error) {
        rmSync(tempPath, { force: true });
        return {
          status: 'failed',
          scriptExitStatus: null,
          scriptErrorMessage: (error as Error).message,
        };
      }
    }

    // On Unix the binary is not locked, so run the script synchronously and
    // stream its output directly to the terminal.
    try {
      const result = spawnSync('/bin/bash', [tempPath], { stdio: 'inherit' });
      if (result.error) {
        return {
          status: 'failed',
          scriptExitStatus: result.status,
          scriptErrorMessage: result.error.message,
        };
      }
      if (result.status !== 0) {
        return { status: 'failed', scriptExitStatus: result.status };
      }

      return { status: 'installed' };
    } finally {
      rmSync(tempPath, { force: true });
    }
  }

  private writeTempScript(scriptName: string, scriptContent: string): string {
    for (let attempt = 0; attempt < TEMP_SCRIPT_CREATE_ATTEMPTS; attempt++) {
      const tempPath = join(tmpdir(), `${TEMP_SCRIPT_PREFIX}${randomUUID()}-${scriptName}`);
      try {
        writeFileSync(tempPath, scriptContent, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        return tempPath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          continue;
        }
        throw error;
      }
    }

    throw new CommandFailedError(
      'Could not create a secure temporary file for the update script.',
      {
        remediationHint: 'Retry later or update manually using the installer script.',
      },
    );
  }

  private async fetchUpdateScript(): Promise<{ scriptContent: string; scriptName: string }> {
    const scriptName = isWindows() ? 'install.ps1' : 'install.sh';
    const scriptBaseUrl =
      process.env.SONARQUBE_CLI_UPDATE_SCRIPT_BASE_URL ?? UPDATE_SCRIPT_BASE_URL;
    const scriptUrl = `${scriptBaseUrl}/${scriptName}`;
    const scriptContent = await fetchText(scriptUrl, 'update script');
    return { scriptContent, scriptName };
  }
}

export interface UpdateCheckResult {
  currentVersion: Version;
  latest: Update;
  upToDate: boolean;
}

async function fetchText(
  url: string,
  description: string,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    ...buildFetchNetworkOptions(url),
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

/**
 * Reads the published stable version from binaries.sonarsource.com and
 * returns version comparison data for update checks.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = new Version(CURRENT_VERSION);
  const latest = new Update(new Version(await fetchLatestVersion()));
  return {
    currentVersion,
    latest,
    upToDate: !latest.version.noBuild.isNewerThan(currentVersion),
  };
}
