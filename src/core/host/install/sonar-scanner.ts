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

import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import {
  BIN_DIR,
  SONAR_SCANNER_DIST_PREFIX,
  SONARSOURCE_BINARIES_URL,
} from '@/core/config-constants.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import logger from '@/core/observability/logger.ts';
import { spawnProcessWithTimeout } from '@/core/process/process.ts';
import { recordInstalledDependency } from '@/core/state/state-manager.ts';
import type { Console } from '@/core/ui/console.ts';

import {
  type PlatformInfo,
  SONAR_SCANNER_BINARY_NAME,
  SONAR_SCANNER_PLATFORM_SUFFIXES,
} from './install-types.ts';
import { ensureBinDirectory } from './install-utils.ts';
import {
  discoverSonarScanner,
  type ScannerInstallation,
  verifyScanner,
} from './scanner-discovery.ts';
import {
  SONAR_SCANNER_CLI_SIGNATURES,
  SONAR_SCANNER_CLI_VERSION,
  SONARSOURCE_PUBLIC_KEY,
} from './signatures.ts';
import { downloadBinary, verifyPgpSignature } from './sonarsource-releases.ts';

const EXTRACTION_TIMEOUT_MS = 120_000;

export const SONAR_SCANNER_VERSION = SONAR_SCANNER_CLI_VERSION;

export function scannerArchive(platform: PlatformInfo) {
  const key = `${platform.os}-${platform.arch}`;
  const suffix = SONAR_SCANNER_PLATFORM_SUFFIXES[key];
  if (!suffix) throw new CommandFailedError(`SonarScanner is not available for platform '${key}'.`);
  const directoryName = `sonar-scanner-${SONAR_SCANNER_VERSION}-${suffix}`;
  const url = `${SONARSOURCE_BINARIES_URL}/${SONAR_SCANNER_DIST_PREFIX}/sonar-scanner-cli-${SONAR_SCANNER_VERSION}-${suffix}.zip`;
  return { suffix, directoryName, url };
}

function managedScanner(home: string): ScannerInstallation {
  return {
    home,
    javaPath: join(home, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
    classPath: join(home, 'lib', `sonar-scanner-cli-${SONAR_SCANNER_VERSION}.jar`),
    version: SONAR_SCANNER_VERSION,
  };
}

/** Checks the downloaded zip against the detached PGP signature pinned in `signatures.ts`. */
export async function verifyScannerArchive(
  bytes: Buffer,
  platform: PlatformInfo,
  signatures: Record<string, string> = SONAR_SCANNER_CLI_SIGNATURES,
  publicKey: string = SONARSOURCE_PUBLIC_KEY,
): Promise<void> {
  const key = `${platform.os}-${platform.arch}`;
  const signature = signatures[key];
  if (!signature) {
    throw new CommandFailedError(`No pinned signature available for SonarScanner on '${key}'.`, {
      remediationHint: 'Refresh signatures with `bun run fetch:signatures`.',
    });
  }
  try {
    await verifyPgpSignature(bytes, signature, publicKey);
  } catch (cause) {
    throw new CommandFailedError('SonarScanner archive signature verification failed.', { cause });
  }
}

async function unpackScanner(archivePath: string, destination: string): Promise<void> {
  const windows = process.platform === 'win32';
  const command = windows ? 'powershell.exe' : 'unzip';
  const args = windows
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:SONAR_INIT_ARCHIVE -DestinationPath $env:SONAR_INIT_DESTINATION',
      ]
    : ['-q', archivePath, '-d', destination];
  const result = await spawnProcessWithTimeout(
    command,
    args,
    {
      env: { SONAR_INIT_ARCHIVE: archivePath, SONAR_INIT_DESTINATION: destination },
    },
    EXTRACTION_TIMEOUT_MS,
    'SonarScanner archive extraction timed out.',
  );
  if (result.exitCode !== 0)
    throw new CommandFailedError('Could not extract the SonarScanner archive.', {
      remediationHint: windows
        ? 'Ensure PowerShell Expand-Archive is available.'
        : 'Install unzip, then retry.',
    });
}

const MANAGED_SCANNER_DIRECTORY = /^sonar-scanner-\d+(?:\.\d+)+-(.+)$/;
const SCANNER_PLATFORM_SUFFIXES = new Set<string>(Object.values(SONAR_SCANNER_PLATFORM_SUFFIXES));

function isManagedScannerDirectory(name: string): boolean {
  const suffix = MANAGED_SCANNER_DIRECTORY.exec(name)?.[1];
  return suffix !== undefined && SCANNER_PLATFORM_SUFFIXES.has(suffix);
}

/**
 * Removes the scanner directories an earlier CLI version installed, so only the pinned one stays.
 * Only names this module creates match, which leaves staging directories and anything else alone.
 */
export function cleanupOldScannerVersions(binDir: string, currentDirectoryName: string): void {
  let names: string[];
  try {
    names = readdirSync(binDir);
  } catch (error) {
    logger.debug(`Could not list ${binDir} to clean up old scanners: ${(error as Error).message}`);
    return;
  }
  for (const name of names) {
    if (name === currentDirectoryName || !isManagedScannerDirectory(name)) continue;
    try {
      rmSync(join(binDir, name), { recursive: true, force: true });
      logger.debug(`Removed old SonarScanner: ${name}`);
    } catch (error) {
      logger.debug(`Could not remove old SonarScanner ${name}: ${(error as Error).message}`);
    }
  }
}

/** A cached install that no longer verifies is deleted so the caller reinstalls instead of failing forever. */
async function cachedScannerIsUsable(scanner: ScannerInstallation): Promise<boolean> {
  if (!existsSync(scanner.javaPath)) return false;
  try {
    await verifyScanner(scanner);
    return true;
  } catch (error) {
    logger.debug(
      `Cached SonarScanner at ${scanner.home} failed verification, reinstalling: ${(error as Error).message}`,
    );
    rmSync(scanner.home, { recursive: true, force: true });
    return false;
  }
}

export async function installSonarScanner(console: Console): Promise<ScannerInstallation> {
  const existing = await discoverSonarScanner();
  if (existing) {
    console.info(`Using installed SonarScanner ${existing.version} from ${existing.home}.`);
    return existing;
  }
  const platform = detectPlatform();
  const archive = scannerArchive(platform);
  const binDir = ensureBinDirectory();
  const scannerHome = join(BIN_DIR, archive.directoryName);
  const scanner = managedScanner(scannerHome);
  if (await cachedScannerIsUsable(scanner)) {
    recordInstalledDependency(
      SONAR_SCANNER_BINARY_NAME,
      SONAR_SCANNER_VERSION,
      scannerHome,
      console,
    );
    cleanupOldScannerVersions(binDir, archive.directoryName);
    console.info(`Using cached SonarScanner ${SONAR_SCANNER_VERSION} from ${scannerHome}.`);
    return scanner;
  }

  const staging = mkdtempSync(join(binDir, '.sonar-scanner-'));
  try {
    console.info(`Installing SonarScanner ${SONAR_SCANNER_VERSION}.`);
    const archivePath = join(staging, 'scanner.zip');
    await console.withSpinner('Downloading SonarScanner', () =>
      downloadBinary(archive.url, archivePath),
    );
    await verifyScannerArchive(readFileSync(archivePath), platform);
    await unpackScanner(archivePath, staging);
    const extracted = join(staging, archive.directoryName);
    await verifyScanner(managedScanner(extracted));
    // Another `sonar init` invocation may have completed installation while this one downloaded.
    if (!existsSync(scannerHome)) renameSync(extracted, scannerHome);
    await verifyScanner(scanner);
    recordInstalledDependency(
      SONAR_SCANNER_BINARY_NAME,
      SONAR_SCANNER_VERSION,
      scannerHome,
      console,
    );
    cleanupOldScannerVersions(binDir, archive.directoryName);
    console.success(`SonarScanner installed at ${scannerHome}`);
    return scanner;
  } catch (cause) {
    if (cause instanceof CommandFailedError) throw cause;
    throw new CommandFailedError('Could not install SonarScanner.', {
      cause,
      remediationHint:
        'Check network access, unzip (or PowerShell on Windows), and executable permissions, then retry.',
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
