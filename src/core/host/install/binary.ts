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

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { BIN_DIR } from '@/core/config-constants.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildPlatformSuffix, type PlatformInfo } from '@/core/host/install/install-types.ts';
import {
  buildDownloadUrl,
  downloadBinary,
  verifyBinarySignature,
} from '@/core/host/install/sonarsource-releases.ts';
import { recordInstalledDependency } from '@/core/state/state-manager.ts';
import { type OutputChannel, print, text, withSpinner } from '@/core/ui';

import {
  cleanupOldVersionBinaries,
  ensureBinDirectory,
  makeExecutable,
  verifyInstallation,
} from './install-utils.ts';

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
  channel?: OutputChannel;
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
 * Delete the local cached binary from disk if present.
 * No-op when absent. Returns true when a file was removed.
 */
export function removeBinary(spec: BinarySpec, binDir?: string): boolean {
  const path = resolveBinaryPath(spec, binDir);
  if (path === null) {
    return false;
  }
  rmSync(path, { force: true });
  return true;
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
    // Heal state when the binary is on disk but not (or no longer) recorded.
    recordInstalledDependency(spec.name, spec.version, binaryPath);
    return { skipped: true, binaryPath };
  }

  const channel = options.channel ?? 'stdout';

  text(`     Installing ${spec.name} ${spec.version}`, undefined, channel);

  const downloadUrl = buildDownloadUrl(spec.name, spec.version, spec.distPrefix, platform);
  await withSpinner(
    `Downloading ${spec.name} ${spec.version}`,
    () => downloadBinary(downloadUrl, binaryPath),
    channel,
  );

  try {
    await withSpinner(
      'Verifying signature',
      () => verifyBinarySignature(binaryPath, platform, spec.signatures, spec.publicKey),
      channel,
    );
  } catch (err) {
    rmSync(binaryPath, { force: true });
    throw err;
  }

  if (platform.os !== 'windows') {
    await makeExecutable(binaryPath);
  }

  const installedVersion = await withSpinner(
    'Verifying installation',
    () => verifyInstallation(binaryPath),
    channel,
  );
  print(`     ${spec.name} ${installedVersion}`, channel);

  recordInstalledDependency(spec.name, spec.version, binaryPath);
  cleanupOldVersionBinaries(resolvedBinDir, spec.name, binaryName);

  return { skipped: false, binaryPath };
}
