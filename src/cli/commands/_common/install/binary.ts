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

// Generic install/resolve pipeline for SonarSource CLI binaries.sonarsource.com dependencies.
// Per-binary modules wrap this with a fixed `BinarySpec`.

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { version as VERSION } from '../../../../../package.json';
import { BIN_DIR } from '../../../../lib/config-constants';
import { buildPlatformSuffix, type PlatformInfo } from '../../../../lib/install-types';
import logger from '../../../../lib/logger';
import { detectPlatform } from '../../../../lib/platform-detector';
import { spawnProcess } from '../../../../lib/process';
import { loadState, saveState } from '../../../../lib/repository/state-repository';
import {
  buildDownloadUrl,
  downloadBinary,
  verifyBinarySignature,
} from '../../../../lib/sonarsource-releases';
import { print, text, warn, withSpinner } from '../../../../ui';
import { CommandFailedError } from '../error';

const FILE_EXECUTABLE_PERMS = 0o755; // rwxr-xr-x
const VERSION_REGEX_MAX_SEGMENT = 20;

export interface BinarySpec {
  name: string;
  version: string;
  distPrefix: string;
  signatures: Record<string, string>;
  publicKey: string;
}

export interface InstallOptions {
  force?: boolean;
  binDir?: string;
}

export interface InstallResult {
  binaryPath: string;
  freshlyInstalled: boolean;
}

export function buildLocalBinaryName(spec: BinarySpec, platform: PlatformInfo): string {
  return `${spec.name}-${spec.version}${buildPlatformSuffix(platform)}`;
}

/**
 * Resolve the local cached path of a binary. Never downloads.
 * Returns null when the binary is not present on disk.
 */
export function resolveBinaryPath(spec: BinarySpec, binDir?: string): string | null {
  const platform = detectPlatform();
  const path = join(binDir ?? BIN_DIR, buildLocalBinaryName(spec, platform));
  return existsSync(path) ? path : null;
}

/**
 * Download, verify, and install a binary into BIN_DIR (or a custom binDir).
 * No-op when the same version is already present unless `force` is set.
 */
export async function installBinary(
  spec: BinarySpec,
  options: InstallOptions = {},
): Promise<InstallResult> {
  const { skipped, binaryPath } = await downloadAndInstall(spec, options);
  return { binaryPath, freshlyInstalled: !skipped };
}

async function downloadAndInstall(
  spec: BinarySpec,
  options: InstallOptions,
): Promise<{ skipped: boolean; binaryPath: string }> {
  const platform = detectPlatform();
  const resolvedBinDir = ensureBinDirectory(options.binDir);
  const binaryName = buildLocalBinaryName(spec, platform);
  const binaryPath = join(resolvedBinDir, binaryName);

  if (!options.force && existsSync(binaryPath)) {
    text(`  ${spec.name} ${spec.version} is already installed (latest)`);
    return { skipped: true, binaryPath };
  }

  text(`Installing ${spec.name} ${spec.version}`);
  text(`  Platform: ${platform.os}-${platform.arch}`);

  const downloadUrl = buildDownloadUrl(spec.name, spec.version, spec.distPrefix, platform);
  await withSpinner(`Downloading ${spec.name} ${spec.version}`, () =>
    downloadBinary(downloadUrl, binaryPath),
  );

  try {
    await withSpinner('Verifying signature', () =>
      verifyBinarySignature(binaryPath, platform, spec.signatures, spec.publicKey),
    );
  } catch (err) {
    rmSync(binaryPath, { force: true });
    throw err;
  }

  if (platform.os !== 'windows') {
    await makeExecutable(binaryPath);
  }

  const installedVersion = await withSpinner('Verifying installation', () =>
    verifyInstallation(binaryPath),
  );
  print(`  ${spec.name} ${installedVersion}`);

  recordInstallationInState(spec.name, installedVersion, binaryPath);
  cleanupOldVersionBinaries(resolvedBinDir, spec.name, binaryName);

  return { skipped: false, binaryPath };
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
    const result = await spawnProcess(path, ['--version'], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode === 0) {
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

function recordInstallationInState(name: string, version: string, path: string): void {
  try {
    const state = loadState();
    state.tools ??= { installed: [] };
    state.tools.installed = state.tools.installed.filter((t) => t.name !== name);
    state.tools.installed.push({
      name,
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

function cleanupOldVersionBinaries(
  binDir: string,
  binaryName: string,
  currentLocalName: string,
): void {
  try {
    const oldFiles = readdirSync(binDir).filter(
      (f) => f.startsWith(`${binaryName}-`) && f !== currentLocalName,
    );
    for (const file of oldFiles) {
      rmSync(join(binDir, file), { force: true });
      logger.debug(`Removed old ${binaryName} binary: ${file}`);
    }
  } catch (err) {
    logger.debug(`Failed to clean up old ${binaryName} binaries: ${(err as Error).message}`);
  }
}
