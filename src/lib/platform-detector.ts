/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Platform detection for sonar-secrets binary installation

import { platform, arch } from 'node:os';
import type { PlatformInfo } from './install-types.js';

const OS_MAP: Record<string, string> = {
  'darwin': 'macos',
  'linux': 'linux',
  'win32': 'windows'
};

const ARCH_MAP: Record<string, string> = {
  'x64': 'x86-64',
  'arm64': 'arm64',
  'arm': 'arm',
  'ia32': '386'
};

/**
 * Detect current platform (OS + architecture)
 */
export function detectPlatform(): PlatformInfo {
  const osPlatform = platform();
  const osArch = arch();

  const mappedOs = OS_MAP[osPlatform] || osPlatform;
  const mappedArch = ARCH_MAP[osArch] || osArch;
  const extension = osPlatform === 'win32' ? '.exe' : '';

  return {
    os: mappedOs,
    arch: mappedArch,
    extension
  };
}

/**
 * Build binary name for GitHub release asset
 * Format: sonar-secrets-<version>-<os>-<arch>[.exe]
 */
export function buildAssetName(
  version: string,
  platformInfo: PlatformInfo
): string {
  // Strip leading 'v' from version if present
  const cleanVersion = version.startsWith('v') ? version.slice(1) : version;

  return `sonar-secrets-${cleanVersion}-${platformInfo.os}-${platformInfo.arch}${platformInfo.extension}`;
}

/**
 * Build local binary filename (without version)
 * Format: sonar-secrets[.exe]
 */
export function buildLocalBinaryName(platformInfo: PlatformInfo): string {
  return `sonar-secrets${platformInfo.extension}`;
}
