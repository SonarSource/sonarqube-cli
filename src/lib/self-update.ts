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

// Self-update logic for the sonarqube-cli binary

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { spawnProcess } from './process.js';
import { version as VERSION } from '../../package.json';
import logger from './logger.js';

const REQUEST_TIMEOUT_MS = 30000;

/**
 * Fetch the latest available CLI version from binaries.sonarsource.com
 */
export async function fetchLatestCliVersion(): Promise<string> {
  const url = `https://gist.githubusercontent.com/sophio-japharidze-sonarsource/ba819f4ad09141c2391ed26db7336a36/raw/ab6769b7d7fee430fd0388d6b27be86344e850b4/latest-version.txt`;

  const response = await fetch(url, {
    headers: { 'User-Agent': `sonarqube-cli/${VERSION}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch latest version: ${response.status} ${response.statusText}`);
  }

  const version = (await response.text()).trim();
  if (!version) {
    throw new Error('Could not determine latest version');
  }

  return version;
}

/**
 * Compare two dot-separated version strings numerically.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

function isWindows(): boolean {
  return platform() === 'win32';
}

const INSTALL_SCRIPT_URL_SH = 'https://gist.githubusercontent.com/kirill-knize-sonarsource/663e7735f883c3b624575f27276a6b79/raw/b9e6add7371f16922a6a7a69d56822906b9e5758/install.sh';
const INSTALL_SCRIPT_URL_PS1 = 'https://gist.githubusercontent.com/kirill-knize-sonarsource/d75dd5f99228f5a67bcd11ec7d2ed295/raw/a5237e27b0c7bff9a5c7bdeec5fe4b112299b5d8/install.ps1';

async function fetchInstallScript(): Promise<string> {
  const url = isWindows() ? INSTALL_SCRIPT_URL_PS1 : INSTALL_SCRIPT_URL_SH;

  logger.debug(`Fetching install script from: ${url}`);

  const response = await fetch(url, {
    headers: { 'User-Agent': `sonarqube-cli/${VERSION}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch install script: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/**
 * Perform a self-update by fetching and running the platform install script.
 * On Unix/macOS: downloads install.sh and runs it with bash.
 * On Windows: downloads install.ps1 and runs it with PowerShell.
 */
export async function performSelfUpdate(): Promise<void> {
  const windows = isWindows();
  const scriptContent = await fetchInstallScript();

  const tmpDir = await mkdtemp(join(tmpdir(), 'sonar-update-'));

  try {
    if (windows) {
      const scriptFile = join(tmpDir, 'install.ps1');
      await writeFile(scriptFile, scriptContent, 'utf8');

      const result = await spawnProcess('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      if (result.exitCode !== 0) {
        throw new Error(`Install script failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
      }
    } else {
      const scriptFile = join(tmpDir, 'install.sh');
      await writeFile(scriptFile, scriptContent, 'utf8');

      const result = await spawnProcess('bash', [scriptFile], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      if (result.exitCode !== 0) {
        throw new Error(`Install script failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
      }
    }
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
