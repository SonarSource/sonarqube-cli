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

// sca-scanner-cli install: thin wrapper over the generic binary install pipeline.

import { SCA_SCANNER_CLI_DIST_PREFIX } from '../../../../lib/config-constants';
import { type PlatformInfo, SCA_SCANNER_BINARY_NAME } from '../../../../lib/install-types';
import {
  SCA_SCANNER_CLI_SIGNATURES,
  SCA_SCANNER_CLI_VERSION,
  SONARSOURCE_PUBLIC_KEY,
} from '../../../../lib/signatures';
import { success } from '../../../../ui';
import { type BinarySpec, buildLocalBinaryName as buildBinaryName, installBinary } from './binary';

export const SCA_SCANNER_SPEC: BinarySpec = {
  name: SCA_SCANNER_BINARY_NAME,
  version: SCA_SCANNER_CLI_VERSION,
  distPrefix: SCA_SCANNER_CLI_DIST_PREFIX,
  signatures: SCA_SCANNER_CLI_SIGNATURES,
  publicKey: SONARSOURCE_PUBLIC_KEY,
};

export async function installScaScannerBinary(): Promise<string> {
  const { binaryPath, freshlyInstalled } = await installBinary(SCA_SCANNER_SPEC);
  if (freshlyInstalled) {
    success(`${SCA_SCANNER_BINARY_NAME} installed at ${binaryPath}`);
  }
  return binaryPath;
}

export function buildLocalBinaryName(platformInfo: PlatformInfo): string {
  return buildBinaryName(SCA_SCANNER_SPEC, platformInfo);
}

export interface ScaScannerInstaller {
  install(): Promise<string>;
}

export class DefaultScaScannerInstaller implements ScaScannerInstaller {
  install(): Promise<string> {
    return installScaScannerBinary();
  }
}
