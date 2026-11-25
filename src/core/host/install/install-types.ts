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
export const CONTEXT_AUGMENTATION_BINARY_NAME = 'sonar-context-augmentation';
export const CONTAINER_SCANNER_BINARY_NAME = 'sonar-container-scanner';

export type PlatformNamingScheme = 'x64';

export function buildPlatformSuffix(p: PlatformInfo): string {
  return `-${p.os}-${p.arch}${p.extension}`;
}

/**
 * Format the `<os>-<arch>` platform key used by CDN download URLs and signature maps.
 * When `naming` is `'x64'`, maps the CLI's canonical `x86-64` arch to `x64`.
 */
export function formatArtifactPlatformKey(
  platform: Pick<PlatformInfo, 'os' | 'arch'>,
  naming?: PlatformNamingScheme,
): string {
  const arch = naming === 'x64' && platform.arch === 'x86-64' ? 'x64' : platform.arch;
  return `${platform.os}-${arch}`;
}

/**
 * Platform suffix used by sonar-context-augmentation distribution archives.
 * CAG publishes platforms as `linux-x64` / `windows-x64` (not `linux-x86-64`),
 * so we map `x86-64` -> `x64` here. Only used for CAG download paths and the
 * matching local cached filename — `buildPlatformSuffix` is unchanged.
 */
export function buildCagPlatformSuffix(p: PlatformInfo): string {
  return formatArtifactPlatformKey(p, 'x64');
}
