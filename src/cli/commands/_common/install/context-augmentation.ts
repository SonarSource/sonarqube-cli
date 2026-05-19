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

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
import { recordInstallationInState } from '../../../../lib/state-manager';
import { text, withSpinner } from '../../../../ui';
import { CommandFailedError } from '../error';
import {
  cleanupOldVersionBinaries,
  ensureBinDirectory,
  makeExecutable,
  verifyInstallation,
} from './install-utils';
import { extractFileFromTarGz } from './tar';

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
 * Install sonar-context-augmentation when not already present. Returns the
 * binary path.
 */
export async function installContextAugmentationBinary(): Promise<string> {
  const { binaryPath } = await resolveContextAugmentationBinary({});
  return binaryPath;
}

/**
 * Lower-level installer that supports forcing a re-download or installing into
 * a custom directory. Distinct from installBinary (binary.ts) because CAG ships
 * .tar.gz archives requiring a separate detached signature and tar extraction.
 */
export async function resolveContextAugmentationBinary(
  options: ContextAugmentationInstallOptions,
): Promise<ContextAugmentationInstallResult> {
  const platform = detectPlatform();
  const resolvedBinDir = ensureBinDirectory(options.binDir);
  const localName = buildLocalCagBinaryName(platform);
  const binaryPath = join(resolvedBinDir, localName);

  if (!options.force && existsSync(binaryPath)) {
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
    () => Promise.all([downloadBinary(archiveUrl, archivePath), downloadBinary(ascUrl, ascPath)]),
  );

  const archiveBytes = readFileSync(archivePath);
  const armoredSignature = readFileSync(ascPath, 'utf-8');

  try {
    await withSpinner('Verifying signature', () =>
      verifySignatureForPlatform(archiveBytes, armoredSignature, platform),
    );
  } catch (err) {
    rmSync(archivePath, { force: true });
    rmSync(ascPath, { force: true });
    throw err;
  }

  try {
    extractCagBinary(archiveBytes, binaryPath, platform);
  } finally {
    rmSync(archivePath, { force: true });
    rmSync(ascPath, { force: true });
  }

  if (platform.os !== 'windows') {
    await makeExecutable(binaryPath);
  }

  let installedVersion: string;
  try {
    installedVersion = await withSpinner('Verifying installation', () =>
      verifyInstallation(binaryPath),
    );
  } catch (err) {
    rmSync(binaryPath, { force: true });
    throw err;
  }

  recordInstallationInState(CONTEXT_AUGMENTATION_BINARY_NAME, installedVersion, binaryPath);
  cleanupOldVersionBinaries(resolvedBinDir, CONTEXT_AUGMENTATION_BINARY_NAME, localName);

  return { binaryPath, freshlyInstalled: true };
}

async function verifySignatureForPlatform(
  archiveBytes: Buffer,
  armoredSignature: string,
  platform: PlatformInfo,
): Promise<void> {
  const platSuffix = buildCagPlatformSuffix(platform);
  const expected = SONAR_CONTEXT_AUGMENTATION_SIGNATURES[platSuffix];
  if (!expected) {
    throw new CommandFailedError(
      `No pinned signature available for sonar-context-augmentation on ${platSuffix}.`,
      {
        remediationHint: `Refresh signatures with \`bun run fetch:signatures\` or check the release was published for this platform.`,
      },
    );
  }
  if (expected !== armoredSignature.trim()) {
    throw new CommandFailedError(
      `Signature mismatch for sonar-context-augmentation on ${platSuffix}: ` +
        `the downloaded .asc does not match the pinned signature.`,
    );
  }
  await verifyPgpSignature(archiveBytes, armoredSignature, SONARSOURCE_PUBLIC_KEY);
}

function extractCagBinary(archiveBytes: Buffer, destPath: string, platform: PlatformInfo): void {
  const expectedBasename = `${CONTEXT_AUGMENTATION_BINARY_NAME}${platform.extension}`;
  const bytes = extractFileFromTarGz(archiveBytes, expectedBasename);
  if (!bytes) {
    throw new CommandFailedError(
      `Failed to find ${expectedBasename} inside the sonar-context-augmentation archive.`,
    );
  }
  writeFileSync(destPath, bytes);
}
