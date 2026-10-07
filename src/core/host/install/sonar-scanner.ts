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

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import {
  BIN_DIR,
  SONAR_SCANNER_DIST_PREFIX,
  SONARSOURCE_BINARIES_URL,
} from '@/core/config-constants.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { spawnProcessWithTimeout } from '@/core/process/process.ts';
import { recordInstalledDependency } from '@/core/state/state-manager.ts';
import type { Console } from '@/core/ui/console.ts';

import { type PlatformInfo, SONAR_SCANNER_BINARY_NAME } from './install-types.ts';
import { ensureBinDirectory } from './install-utils.ts';
import {
  discoverSonarScanner,
  type ScannerInstallation,
  verifyScanner,
} from './scanner-discovery.ts';
import { downloadBinary } from './sonarsource-releases.ts';

export const SONAR_SCANNER_VERSION = '8.1.0.6389';

// Published checksums: https://github.com/SonarSource/sonarqube-scan-action/blob/master/sonar-scanner-version
const SCANNER_ARCHIVES: Partial<Record<string, { suffix: string; sha256: string }>> = {
  'linux-x86-64': {
    suffix: 'linux-x64',
    sha256: 'bb8f709f9cb73352f8d1260a3b3c506c0f41146754bc630762c126d795499d0b',
  },
  'linux-arm64': {
    suffix: 'linux-aarch64',
    sha256: '5e1c9328f4e261838de778c9e586ee608cca45ff7f0538108642219214628ba5',
  },
  'macos-x86-64': {
    suffix: 'macosx-x64',
    sha256: '8afc8bbff9008434e53b31cb681333ff643b999f84ca537db573d0fae8883cdc',
  },
  'macos-arm64': {
    suffix: 'macosx-aarch64',
    sha256: '20d12be4081896b337cd873d98ebd3d554be666086a45e31dd84a12ef51c3688',
  },
  'windows-x86-64': {
    suffix: 'windows-x64',
    sha256: '73f0e71928673d5b2f39bb86213342a30e51a14c8eec345164016bb29c8df8ee',
  },
};

export function scannerArchive(platform: PlatformInfo) {
  const key = `${platform.os}-${platform.arch}`;
  const archive = SCANNER_ARCHIVES[key];
  if (!archive)
    throw new CommandFailedError(`SonarScanner is not available for platform '${key}'.`);
  const directoryName = `sonar-scanner-${SONAR_SCANNER_VERSION}-${archive.suffix}`;
  const url = `${SONARSOURCE_BINARIES_URL}/${SONAR_SCANNER_DIST_PREFIX}/sonar-scanner-cli-${SONAR_SCANNER_VERSION}-${archive.suffix}.zip`;
  return { ...archive, directoryName, url };
}

function managedScanner(home: string): ScannerInstallation {
  return {
    home,
    javaPath: join(home, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
    classPath: join(home, 'lib', `sonar-scanner-cli-${SONAR_SCANNER_VERSION}.jar`),
    version: SONAR_SCANNER_VERSION,
  };
}

export function verifyScannerArchive(bytes: Buffer, platform: PlatformInfo): void {
  const checksum = createHash('sha256').update(bytes).digest('hex');
  if (checksum !== scannerArchive(platform).sha256) {
    throw new CommandFailedError('SonarScanner archive checksum verification failed.');
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
        '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:SONAR_ONBOARD_ARCHIVE -DestinationPath $env:SONAR_ONBOARD_DESTINATION',
      ]
    : ['-q', archivePath, '-d', destination];
  const result = await spawnProcessWithTimeout(
    command,
    args,
    {
      env: { SONAR_ONBOARD_ARCHIVE: archivePath, SONAR_ONBOARD_DESTINATION: destination },
    },
    120000,
    'SonarScanner archive extraction timed out.',
  );
  if (result.exitCode !== 0)
    throw new CommandFailedError('Could not extract the SonarScanner archive.', {
      remediationHint: windows
        ? 'Ensure PowerShell Expand-Archive is available.'
        : 'Install unzip, then retry.',
    });
}

export async function installSonarScanner(console: Console): Promise<ScannerInstallation> {
  const existing = await discoverSonarScanner();
  if (existing) {
    console.info(`Using installed SonarScanner ${existing.version} from ${existing.home}.`);
    return existing;
  }
  const archive = scannerArchive(detectPlatform());
  const binDir = ensureBinDirectory();
  const scannerHome = join(BIN_DIR, archive.directoryName);
  const scanner = managedScanner(scannerHome);
  if (existsSync(scanner.javaPath)) {
    await verifyScanner(scanner);
    recordInstalledDependency(
      SONAR_SCANNER_BINARY_NAME,
      SONAR_SCANNER_VERSION,
      scannerHome,
      console,
    );
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
    verifyScannerArchive(readFileSync(archivePath), detectPlatform());
    await unpackScanner(archivePath, staging);
    const extracted = join(staging, archive.directoryName);
    await verifyScanner(managedScanner(extracted));
    // Another onboarding invocation may have completed installation while this one downloaded.
    if (!existsSync(scannerHome)) renameSync(extracted, scannerHome);
    await verifyScanner(scanner);
    recordInstalledDependency(
      SONAR_SCANNER_BINARY_NAME,
      SONAR_SCANNER_VERSION,
      scannerHome,
      console,
    );
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
