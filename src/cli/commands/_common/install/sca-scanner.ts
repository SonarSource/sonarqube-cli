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

// sca-scanner install: thin wrapper over the generic binary install pipeline.
// Version + signatures are placeholders until the binary is published on
// binaries.sonarsource.com — `installScaScannerBinary()` will throw until then,
// and `analyze dependency-risks` falls back to a mocked empty result.

import { SONAR_SCA_SCANNER_DIST_PREFIX } from '../../../../lib/config-constants';
import { SCA_SCANNER_BINARY_NAME } from '../../../../lib/install-types';
import {
  SONAR_SCA_SCANNER_SIGNATURES,
  SONAR_SCA_SCANNER_VERSION,
  SONARSOURCE_PUBLIC_KEY,
} from '../../../../lib/signatures';
import { success } from '../../../../ui';
import { type BinarySpec, installBinary, resolveBinaryPath } from './binary';

const SCA_SCANNER_SPEC: BinarySpec = {
  name: SCA_SCANNER_BINARY_NAME,
  version: SONAR_SCA_SCANNER_VERSION,
  distPrefix: SONAR_SCA_SCANNER_DIST_PREFIX,
  signatures: SONAR_SCA_SCANNER_SIGNATURES,
  publicKey: SONARSOURCE_PUBLIC_KEY,
};

export async function installScaScannerBinary(): Promise<string> {
  const { binaryPath, freshlyInstalled } = await installBinary(SCA_SCANNER_SPEC);
  if (freshlyInstalled) {
    success(`sca-scanner installed at ${binaryPath}`);
  }
  return binaryPath;
}

export function resolveScaScannerBinaryPath(): string | null {
  return resolveBinaryPath(SCA_SCANNER_SPEC);
}

export interface ScaScannerInstallerLike {
  install(): Promise<string>;
}

export class DefaultScaScannerInstaller implements ScaScannerInstallerLike {
  install(): Promise<string> {
    return installScaScannerBinary();
  }
}

// TODO(SCA wiring): remove this temporary hardcoded path and switch back to
// `DefaultScaScannerInstaller` once the binary is published.
const TEMP_SCA_SCANNER_PATH =
  'C:\\Users\\georgii.borovinskikh\\Desktop\\tmp\\SCA\\sca-scanner-windows-x86-64.exe';

export class TempScaScannerInstaller implements ScaScannerInstallerLike {
  install(): Promise<string> {
    return Promise.resolve(TEMP_SCA_SCANNER_PATH);
  }
}

export class MockScaScannerInstaller implements ScaScannerInstallerLike {
  install(): Promise<string> {
    return Promise.resolve('any path');
  }
}
