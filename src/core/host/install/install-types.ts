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

// Types for binary installation

export interface PlatformInfo {
  os: string;
  arch: string;
  extension: string;
}

export const SECRETS_BINARY_NAME = 'sonar-secrets';
export const SCA_SCANNER_BINARY_NAME = 'sca-scanner-cli';
export const SONAR_SCANNER_BINARY_NAME = 'sonar-scanner';
export const CONTEXT_AUGMENTATION_BINARY_NAME = 'sonar-context-augmentation';

export function buildPlatformSuffix(p: PlatformInfo): string {
  return `-${p.os}-${p.arch}${p.extension}`;
}

/**
 * Platform part of the sonar-scanner-cli archive name (`sonar-scanner-cli-<version>-<suffix>.zip`),
 * keyed by `<os>-<arch>`. Shared with `build-scripts/fetch-signatures.ts`, which fetches the
 * matching `.asc` files.
 */
export const SONAR_SCANNER_PLATFORM_SUFFIXES: Readonly<Record<string, string>> = {
  'linux-x86-64': 'linux-x64',
  'linux-arm64': 'linux-aarch64',
  'macos-x86-64': 'macosx-x64',
  'macos-arm64': 'macosx-aarch64',
  'windows-x86-64': 'windows-x64',
};

/**
 * Platform suffix used by sonar-context-augmentation distribution archives.
 * CAG publishes platforms as `linux-x64` / `windows-x64` (not `linux-x86-64`),
 * so we map `x86-64` -> `x64` here. Only used for CAG download paths and the
 * matching local cached filename — `buildPlatformSuffix` is unchanged.
 */
export function buildCagPlatformSuffix(p: PlatformInfo): string {
  const arch = p.arch === 'x86-64' ? 'x64' : p.arch;
  return `${p.os}-${arch}`;
}
