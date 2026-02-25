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

import { existsSync } from 'node:fs';
import { copyFile, chmod, rename, unlink, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnProcess } from './process.js';
import { version as VERSION } from '../../package.json';
import { SONARSOURCE_BINARIES_URL, SONARQUBE_CLI_DIST_PREFIX } from './config-constants.js';
import { detectPlatform } from './platform-detector.js';
import logger from './logger.js';

const REQUEST_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 120000;

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

/**
 * Build the download URL for a given CLI version on the current platform.
 * Naming convention: sonarqube-cli-<version>-<os>-<arch>.exe
 */
function buildCliDownloadUrl(version: string): string {
  const platform = detectPlatform();
  const filename = `sonarqube-cli-${version}-${platform.os}-${platform.arch}.exe`;
  return `${SONARSOURCE_BINARIES_URL}/${SONARQUBE_CLI_DIST_PREFIX}/${filename}`;
}

/**
 * Download the CLI binary to a temporary file and return its path.
 */
async function downloadToTemp(url: string): Promise<{ tmpDir: string; tmpFile: string }> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'sonar-update-'));
  const tmpFile = join(tmpDir, 'sonar.download');

  logger.debug(`Downloading SonarQubeCLI from: ${url}`);

  const response = await fetch(url, {
    headers: { 'User-Agent': `sonarqube-cli/${VERSION}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  await writeFile(tmpFile, Buffer.from(buffer));

  return { tmpDir, tmpFile };
}

/**
 * Verify a binary responds correctly to --version, returning the version string.
 */
async function verifyBinary(binaryPath: string): Promise<string> {
  const result = await spawnProcess(binaryPath, ['--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    throw new Error('Downloaded binary failed version check');
  }

  const combined = result.stdout + ' ' + result.stderr;

  const match = /(\d{1,20}(?:\.\d{1,20}){1,3})/.exec(combined);
  if (!match) {
    throw new Error('Could not parse version from downloaded binary output');
  }

  return match[1];
}

/**
 * Remove macOS quarantine attribute from the file (no-op if not quarantined).
 */
async function removeQuarantine(filePath: string): Promise<void> {
  try {
    await spawnProcess('xattr', ['-d', 'com.apple.quarantine', filePath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    // Binary is not quarantined — this is expected and fine
  }
}

/**
 * Download the new binary, set permissions, and stage it at newBinaryPath.
 * Returns the temp directory path so the caller can clean it up.
 */
async function prepareNewBinary(downloadUrl: string, newBinaryPath: string): Promise<string> {
  const platform = detectPlatform();
  const { tmpDir, tmpFile } = await downloadToTemp(downloadUrl);

  if (platform.os !== 'windows') {
    await chmod(tmpFile, 0o755);
  }
  if (platform.os === 'macos') {
    await removeQuarantine(tmpFile);
  }

  await copyFile(tmpFile, newBinaryPath);
  if (platform.os !== 'windows') {
    await chmod(newBinaryPath, 0o755);
  }

  return tmpDir;
}

/**
 * Atomically swap newBinaryPath into currentBinaryPath, verify the result, then
 * clean up. On verification failure, restores the backup when one was created, or
 * removes the failed binary entirely when there was no original to restore.
 */
async function swapAndVerify(currentBinaryPath: string, newBinaryPath: string, backupPath: string): Promise<string> {
  const backupCreated = existsSync(currentBinaryPath);
  if (backupCreated) {
    await rename(currentBinaryPath, backupPath);
  }
  await rename(newBinaryPath, currentBinaryPath);

  try {
    const installedVersion = await verifyBinary(currentBinaryPath);
    if (backupCreated && existsSync(backupPath)) {
      await unlink(backupPath);
    }
    return installedVersion;
  } catch (error_) {
    logger.warn(`Verification failed, rolling back: ${(error_ as Error).message}`);
    if (backupCreated && existsSync(backupPath)) {
      await rename(backupPath, currentBinaryPath);
    } else if (!backupCreated) {
      try {
        await unlink(currentBinaryPath);
      } catch {
        // Ignore cleanup errors
      }
    }
    throw error_;
  }
}

/**
 * Perform an in-place binary self-update with rollback on failure.
 *
 * Strategy:
 *  1. Download new binary to system tmpdir
 *  2. Copy to <binaryPath>.new (same FS → avoids cross-device rename)
 *  3. Rename current binary to <binaryPath>.backup  (atomic)
 *  4. Rename .new to current path                  (atomic)
 *  5. Verify the new binary works
 *  6. On success: remove backup
 *  7. On failure: restore backup (or remove failed binary if no backup), throw
 */
export async function performSelfUpdate(version: string): Promise<string> {
  const currentBinaryPath = process.execPath;
  const newBinaryPath = `${currentBinaryPath}.new`;
  const backupPath = `${currentBinaryPath}.backup`;

  let tmpDir: string | null = null;

  try {
    tmpDir = await prepareNewBinary(buildCliDownloadUrl(version), newBinaryPath);
    return await swapAndVerify(currentBinaryPath, newBinaryPath, backupPath);
  } finally {
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    if (existsSync(newBinaryPath)) {
      try {
        await unlink(newBinaryPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
