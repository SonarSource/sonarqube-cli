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

import { BIN_DIR } from '../../../../lib/config-constants';
import { buildPlatformSuffix, type PlatformInfo } from '../../../../lib/install-types';
import { detectPlatform } from '../../../../lib/platform-detector';
import {
  buildDownloadUrl,
  downloadBinary,
  verifyBinarySignature,
} from '../../../../lib/sonarsource-releases';
import { recordInstallationInState } from '../../../../lib/state-manager';
import { print, text, withSpinner } from '../../../../ui';
import {
  cleanupOldVersionBinaries,
  ensureBinDirectory,
  makeExecutable,
  verifyInstallation,
} from './install-utils';

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
