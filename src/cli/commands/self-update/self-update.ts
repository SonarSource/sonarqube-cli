/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { version as CURRENT_VERSION } from '../../../../package.json';
import { UPDATE_SCRIPT_BASE_URL } from '../../../lib/config-constants';
import { isNewerVersion, stripBuildNumber } from '../../../lib/version';
import { info, success, warn, text, blank } from '../../../ui';

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
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const isWindows = process.platform === 'win32';
  const scriptName = isWindows ? 'install.ps1' : 'install.sh';
  const scriptUrl = `${UPDATE_SCRIPT_BASE_URL}/${scriptName}`;

  const response = await fetch(scriptUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch update script: HTTP ${response.status}`);
  }

  const scriptContent = await response.text();
  const latestVersion = extractVersion(scriptContent);
  if (latestVersion === null) {
    throw new Error('Could not determine the latest version from the install script');
  }

  return {
    currentVersion: CURRENT_VERSION,
    latestVersion,
    updateAvailable: isNewerVersion(CURRENT_VERSION, stripBuildNumber(latestVersion)),
    scriptContent,
    scriptName,
  };
}

export interface SelfUpdateOptions {
  status?: boolean;
  force?: boolean;
}

async function selfUpdateStatus(): Promise<void> {
  info('Checking for updates...');

  const { currentVersion, latestVersion, updateAvailable } = await checkForUpdate();

  const displayLatest = stripBuildNumber(latestVersion);
  text(`Current version: v${currentVersion}`);
  text(`Latest version:  v${displayLatest}`);
  blank();

  if (updateAvailable) {
    warn(`Update available: v${displayLatest}`);
    text('  Run: sonar self-update');
  } else {
    success('Already up to date');
  }
}

export async function selfUpdate(options: SelfUpdateOptions = {}): Promise<void> {
  if (options.status) {
    await selfUpdateStatus();
    return;
  }

  info('Checking for updates...');

  const { currentVersion, latestVersion, updateAvailable, scriptContent, scriptName } =
    await checkForUpdate();

  if (!updateAvailable && !options.force) {
    success(`Already up to date (v${currentVersion})`);
    return;
  }

  if (updateAvailable) {
    info(`Updating v${currentVersion} → v${latestVersion}...`);
  } else {
    info(`Force installing v${latestVersion}...`);
  }

  const tempPath = join(tmpdir(), scriptName);

  if (process.platform === 'win32') {
    // On Windows the running binary is file-locked, so the parent must exit immediately
    // so that the script can overwrite the executable. Otherwise, the update will fail and
    // has to be manually retried by the user.
    // Open PowerShell in a new window so it has its own console and the user can see the output.
    writeFileSync(tempPath, scriptContent, 'utf8');
    info('Starting update in a new terminal window...');
    // The ComSpec environment variable (always points to the system cmd.exe)
    const cmdExe = process.env.ComSpec ?? String.raw`C:\Windows\System32\cmd.exe`;
    const child = spawn(
      cmdExe,
      ['/c', 'start', 'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', tempPath],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  } else {
    // On Unix the binary is not locked, so run the script synchronously and
    // stream its output directly to the terminal.
    writeFileSync(tempPath, scriptContent, { encoding: 'utf8', mode: 0o755 });
    const result = spawnSync('/bin/bash', [tempPath], { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`Update script exited with code ${String(result.status ?? 'unknown')}`);
    }
  }
}
