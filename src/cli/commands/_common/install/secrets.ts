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

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnProcess } from '../../../../lib/process';
import { BIN_DIR } from '../../../../lib/config-constants';
import { buildLocalBinaryName, detectPlatform } from '../../../../lib/platform-detector';
import {
  buildDownloadUrl,
  downloadBinary,
  verifyBinarySignature,
} from '../../../../lib/sonarsource-releases';
import {
  SONAR_SECRETS_VERSION,
  SONAR_SECRETS_SIGNATURES,
  SONARSOURCE_PUBLIC_KEY,
} from '../../../../lib/signatures';
import { loadState, saveState } from '../../../../lib/state-manager';
import { version as VERSION } from '../../../../../package.json';
import logger from '../../../../lib/logger';
import type { PlatformInfo } from '../../../../lib/install-types';
import { SECRETS_BINARY_NAME } from '../../../../lib/install-types';
import { text, warn, withSpinner, print } from '../../../../ui';
import { CommandFailedError } from '../error';

const FILE_EXECUTABLE_PERMS = 0o755; // rwxr-xr-x
const VERSION_REGEX_MAX_SEGMENT = 20;

/**
 * Core install logic for sonar-secrets binary download and setup
 */
export async function performSecretInstall(
  options: { force?: boolean },
  { binDir }: { binDir?: string } = {},
): Promise<{ binaryPath: string; freshlyInstalled: boolean }> {
  const platform = detectPlatform();
  const resolvedBinDir = ensureBinDirectory(binDir);
  const binaryPath = join(resolvedBinDir, buildLocalBinaryName(platform));

  text(`Platform: ${platform.os}-${platform.arch}`);

  const { skipped } = await performInstallation(options, platform, binaryPath);
  return { binaryPath, freshlyInstalled: !skipped };
}

async function performInstallation(
  options: { force?: boolean },
  platform: PlatformInfo,
  binaryPath: string,
): Promise<{ skipped: boolean }> {
  // Check existing installation
  if (!options.force) {
    const skipStatus = await checkExistingInstallation(binaryPath);
    if (skipStatus) {
      return { skipped: true };
    }
  }

  // Download pinned version
  const version = SONAR_SECRETS_VERSION;
  print(`  Version: ${version}`);

  const downloadUrl = buildDownloadUrl(version, platform);
  await withSpinner(`Downloading sonar-secrets ${version}`, () =>
    downloadBinary(downloadUrl, binaryPath),
  );

  try {
    await withSpinner('Verifying signature', () =>
      verifyBinarySignature(binaryPath, platform, SONAR_SECRETS_SIGNATURES, SONARSOURCE_PUBLIC_KEY),
    );
  } catch (err) {
    const { rmSync } = await import('node:fs');
    rmSync(binaryPath, { force: true });
    throw err;
  }

  if (platform.os !== 'windows') {
    await makeExecutable(binaryPath);
  }

  // Verify and finalize
  const installedVersion = await withSpinner('Verifying installation', () =>
    verifyInstallation(binaryPath),
  );
  print(`  sonar-secrets ${installedVersion}`);

  recordInstallationInState(installedVersion, binaryPath);
  return { skipped: false };
}

function ensureBinDirectory(dir?: string): string {
  const binDir = dir ?? BIN_DIR;
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }
  return binDir;
}

async function makeExecutable(path: string): Promise<void> {
  const { chmod } = await import('node:fs/promises');
  await chmod(path, FILE_EXECUTABLE_PERMS);
}

async function checkInstalledVersion(path: string): Promise<string | null> {
  try {
    const result = await spawnProcess(path, ['--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (result.exitCode === 0) {
      // Parse version from output — limit backtracking with fixed max segment length
      const pattern = String.raw`(\d{1,${VERSION_REGEX_MAX_SEGMENT}}(?:\.\d{1,${VERSION_REGEX_MAX_SEGMENT}}){2,3})`;
      const versionRegex = new RegExp(pattern);
      const match = versionRegex.exec(result.stdout);
      return match ? match[1] : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function verifyInstallation(path: string): Promise<string> {
  const version = await checkInstalledVersion(path);
  if (!version) {
    throw new CommandFailedError(
      'Installation verification failed. Binary not responding to --version.',
    );
  }
  return version;
}

function recordInstallationInState(version: string, path: string): void {
  try {
    const state = loadState();

    state.tools ??= { installed: [] };

    state.tools.installed = state.tools.installed.filter((t) => t.name !== SECRETS_BINARY_NAME);

    state.tools.installed.push({
      name: SECRETS_BINARY_NAME,
      version,
      path,
      installedAt: new Date().toISOString(),
      installedByCliVersion: VERSION,
    });

    saveState(state);
  } catch (err) {
    warn(`Failed to update state: ${(err as Error).message}`);
    logger.warn(`Failed to update state: ${(err as Error).message}`);
  }
}

async function checkExistingInstallation(binaryPath: string): Promise<boolean> {
  if (!existsSync(binaryPath)) {
    return false;
  }

  const existingVersion = await checkInstalledVersion(binaryPath);
  if (!existingVersion) {
    return false;
  }

  const pinnedVersion = SONAR_SECRETS_VERSION;

  if (existingVersion === pinnedVersion) {
    text(`sonar-secrets ${existingVersion} is already installed (latest)`);
    return true;
  }

  warn(`Version mismatch: ${existingVersion} ≠ ${pinnedVersion}`);
  text('  Updating...\n');
  return false;
}
