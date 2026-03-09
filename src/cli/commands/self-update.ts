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
import { version as CURRENT_VERSION } from '../../../package.json';
import { UPDATE_SCRIPT_BASE_URL } from '../../lib/config-constants';
import { info, success, warn, text, blank } from '../../ui';

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

/**
 * Strips the build number (4th segment) from a version string.
 * The install script version may include a build number (e.g. "0.5.0.241") while
 * the CLI version from package.json only has three segments ("0.5.0").
 */
export function stripBuildNumber(version: string): string {
  return version.split('.').slice(0, 3).join('.');
}

/** Returns true when `candidate` is strictly newer than `current` (semver, numeric comparison). */
export function isNewerVersion(current: string, candidate: string): boolean {
  const parse = (v: string): number[] => v.split('.').map(Number);
  const curr = parse(current);
  const cand = parse(candidate);
  for (let i = 0; i < Math.max(curr.length, cand.length); i++) {
    const c = curr[i] ?? 0;
    const f = cand[i] ?? 0;
    if (f > c) return true;
    if (f < c) return false;
  }
  return false;
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
    // On Windows the running binary is file-locked, so the parent must exit
    // before the script can overwrite it. Open PowerShell in a new window so
    // it has its own console and the user can see the output.
    writeFileSync(tempPath, scriptContent, 'utf8');
    info('Starting update in a new terminal window...');
    const child = spawn(
      'cmd',
      ['/c', 'start', 'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', tempPath],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    process.exit(0);
  } else {
    // On Unix the binary is not locked, so run the script synchronously and
    // stream its output directly to the terminal.
    writeFileSync(tempPath, scriptContent, { encoding: 'utf8', mode: 0o755 });
    const result = spawnSync('bash', [tempPath], { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`Update script exited with code ${String(result.status ?? 'unknown')}`);
    }
  }
}
