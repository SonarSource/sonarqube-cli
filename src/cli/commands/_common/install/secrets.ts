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

// sonar-secrets install: thin wrapper over the generic binary install pipeline.

import { SONAR_SECRETS_DIST_PREFIX } from '../../../../lib/config-constants';
import { type PlatformInfo, SECRETS_BINARY_NAME } from '../../../../lib/install-types';
import {
  SONAR_SECRETS_SIGNATURES,
  SONAR_SECRETS_VERSION,
  SONARSOURCE_PUBLIC_KEY,
} from '../../../../lib/signatures';
import { success } from '../../../../ui';
import {
  type BinarySpec,
  buildLocalBinaryName as buildBinaryName,
  installBinary,
  type InstallResult,
  resolveBinaryPath,
} from './binary';

const SECRETS_SPEC: BinarySpec = {
  name: SECRETS_BINARY_NAME,
  version: SONAR_SECRETS_VERSION,
  distPrefix: SONAR_SECRETS_DIST_PREFIX,
  signatures: SONAR_SECRETS_SIGNATURES,
  publicKey: SONARSOURCE_PUBLIC_KEY,
};

/**
 * Install sonar-secrets if not already present, and report success if freshly installed.
 * Use this in commands where the user implicitly consents to installation by running the command.
 */
export async function installSecretsBinary(): Promise<string> {
  const { binaryPath, freshlyInstalled } = await resolveSecretsBinary({});
  if (freshlyInstalled) {
    success(`sonar-secrets installed at ${binaryPath}`);
  }
  return binaryPath;
}

export async function resolveSecretsBinary(
  options: { force?: boolean },
  { binDir }: { binDir?: string } = {},
): Promise<InstallResult> {
  return installBinary(SECRETS_SPEC, { ...options, binDir });
}

/**
 * Returns the path to the installed sonar-secrets binary, or null if not present.
 * Never downloads — use this where silent operation is required (e.g. hook handlers).
 */
export function resolveSecretsBinaryPath(): string | null {
  return resolveBinaryPath(SECRETS_SPEC);
}

/**
 * Build local binary filename with version embedded.
 * Format: sonar-secrets-{version}-{os}-{arch}[.exe]
 * Example: sonar-secrets-2.41.0.10709-linux-x86-64
 */
export function buildLocalBinaryName(platformInfo: PlatformInfo): string {
  return buildBinaryName(SECRETS_SPEC, platformInfo);
}
