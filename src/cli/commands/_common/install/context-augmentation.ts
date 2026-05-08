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

// sonar-context-augmentation install: download .tar.gz archive, verify
// detached PGP signature, extract the inner binary, then record state.
//
// Distinct from src/cli/commands/_common/install/binary.ts (which assumes a
// single-file artifact) because CAG ships .tar.gz archives. We share signature
// verification and state-recording helpers but the download/extract pipeline is
// custom.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BIN_DIR } from '../../../../lib/config-constants';
import {
  buildCagPlatformSuffix,
  CONTEXT_AUGMENTATION_BINARY_NAME,
  type PlatformInfo,
} from '../../../../lib/install-types';
import { detectPlatform } from '../../../../lib/platform-detector';
import {
  SONAR_CONTEXT_AUGMENTATION_SIGNATURES,
  SONAR_CONTEXT_AUGMENTATION_VERSION,
  SONARSOURCE_PUBLIC_KEY,
} from '../../../../lib/signatures';
import {
  buildCagDownloadUrl,
  downloadBinary,
  verifyPgpSignature,
} from '../../../../lib/sonarsource-releases';
import { print, success, text, withSpinner } from '../../../../ui';
import { CommandFailedError } from '../error';
import {
  cleanupOldVersionBinaries,
  recordInstallationInState,
  verifyInstallation,
} from './state-helpers';
import { extractFileFromTarGz } from './tar';

const FILE_EXECUTABLE_PERMS = 0o755; // rwxr-xr-x

export interface ContextAugmentationInstallOptions {
  force?: boolean;
  binDir?: string;
}

export interface ContextAugmentationInstallResult {
  binaryPath: string;
  freshlyInstalled: boolean;
}

/**
 * Build the local cached binary filename, e.g.
 *   sonar-context-augmentation-0.9.0.355-macos-arm64
 *   sonar-context-augmentation-0.9.0.355-windows-x64.exe
 */
export function buildLocalCagBinaryName(platform: PlatformInfo): string {
  const platSuffix = buildCagPlatformSuffix(platform);
  return `${CONTEXT_AUGMENTATION_BINARY_NAME}-${SONAR_CONTEXT_AUGMENTATION_VERSION}-${platSuffix}${platform.extension}`;
}

/**
 * Returns the path to the installed sonar-context-augmentation binary, or null
 * when not present. Never downloads — used by `sonar context` passthrough where
 * silent operation is required.
 */
export function resolveContextAugmentationBinaryPath(): string | null {
  const platform = detectPlatform();
  const path = join(BIN_DIR, buildLocalCagBinaryName(platform));
  return existsSync(path) ? path : null;
}

/**
 * Install sonar-context-augmentation when not already present, and report
 * success when freshly installed. Returns the binary path.
 */
export async function installContextAugmentationBinary(): Promise<string> {
  const { binaryPath, freshlyInstalled } = await resolveContextAugmentationBinary({});
  if (freshlyInstalled) {
    success(`sonar-context-augmentation installed at ${binaryPath}`);
  }
  return binaryPath;
}

/**
 * Lower-level installer that supports forcing a re-download or installing into
 * a custom directory. Mirrors the shape of `installBinary` from binary.ts.
 */
export async function resolveContextAugmentationBinary(
  options: ContextAugmentationInstallOptions,
  { binDir }: { binDir?: string } = {},
): Promise<ContextAugmentationInstallResult> {
  const platform = detectPlatform();
  const resolvedBinDir = ensureBinDirectory(binDir ?? options.binDir);
  const localName = buildLocalCagBinaryName(platform);
  const binaryPath = join(resolvedBinDir, localName);

  if (!options.force && existsSync(binaryPath)) {
    text(
      `  sonar-context-augmentation ${SONAR_CONTEXT_AUGMENTATION_VERSION} is already installed (latest)`,
    );
    return { binaryPath, freshlyInstalled: false };
  }

  text(`Installing sonar-context-augmentation ${SONAR_CONTEXT_AUGMENTATION_VERSION}`);
  text(`  Platform: ${platform.os}-${platform.arch}`);

  const archivePath = `${binaryPath}.tar.gz`;
  const ascPath = `${archivePath}.asc`;
  const archiveUrl = buildCagDownloadUrl(SONAR_CONTEXT_AUGMENTATION_VERSION, platform);
  const ascUrl = `${archiveUrl}.asc`;

  await withSpinner(
    `Downloading sonar-context-augmentation ${SONAR_CONTEXT_AUGMENTATION_VERSION}`,
    async () => {
      await downloadBinary(archiveUrl, archivePath);
      await downloadBinary(ascUrl, ascPath);
    },
  );

  try {
    await withSpinner('Verifying signature', async () => {
      const archiveBytes = readFileSync(archivePath);
      const armoredSignature = readFileSync(ascPath, 'utf-8');
      await verifySignatureForPlatform(archiveBytes, armoredSignature, platform);
    });
  } catch (err) {
    rmSync(archivePath, { force: true });
    rmSync(ascPath, { force: true });
    throw err;
  }

  try {
    extractCagBinary(archivePath, binaryPath, platform);
  } finally {
    rmSync(archivePath, { force: true });
    rmSync(ascPath, { force: true });
  }

  if (platform.os !== 'windows') {
    await makeExecutable(binaryPath);
  }

  const installedVersion = await withSpinner('Verifying installation', () =>
    verifyInstallation(binaryPath),
  );
  print(`  sonar-context-augmentation ${installedVersion}`);

  recordInstallationInState(CONTEXT_AUGMENTATION_BINARY_NAME, installedVersion, binaryPath);
  cleanupOldVersionBinaries(resolvedBinDir, CONTEXT_AUGMENTATION_BINARY_NAME, localName);

  return { binaryPath, freshlyInstalled: true };
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

async function verifySignatureForPlatform(
  archiveBytes: Buffer,
  armoredSignature: string,
  platform: PlatformInfo,
): Promise<void> {
  const platSuffix = buildCagPlatformSuffix(platform);
  const expected = SONAR_CONTEXT_AUGMENTATION_SIGNATURES[platSuffix];
  if (!expected) {
    // Pinned signatures are populated by `bun run fetch:signatures`. When the
    // map is empty (e.g. before the first signature fetch on a fresh checkout),
    // we still verify against the on-disk .asc — verifyPgpSignature confirms
    // the signature was issued by the trusted SonarSource key. We don't insist
    // on an exact match against the pinned signature when none is pinned.
    await verifyPgpSignature(archiveBytes, armoredSignature, SONARSOURCE_PUBLIC_KEY);
    return;
  }
  if (expected !== armoredSignature.trim()) {
    throw new CommandFailedError(
      `Signature mismatch for sonar-context-augmentation on ${platSuffix}: ` +
        `the downloaded .asc does not match the pinned signature.`,
    );
  }
  await verifyPgpSignature(archiveBytes, armoredSignature, SONARSOURCE_PUBLIC_KEY);
}

/**
 * Extract the sonar-context-augmentation binary from a .tar.gz archive into
 * destPath. Throws CommandFailedError when the expected entry is missing.
 */
function extractCagBinary(archivePath: string, destPath: string, platform: PlatformInfo): void {
  const expectedBasename = `${CONTEXT_AUGMENTATION_BINARY_NAME}${platform.extension}`;
  const bytes = extractFileFromTarGz(readFileSync(archivePath), expectedBasename);
  if (!bytes) {
    throw new CommandFailedError(
      `Failed to find ${expectedBasename} inside the sonar-context-augmentation archive.`,
    );
  }
  writeFileSync(destPath, bytes);
}
