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

import { describe, expect, it } from 'bun:test';

import { buildLocalBinaryName, resolveBinaryArtifact } from '@/core/host/install/binary.ts';
import { CONTAINER_SCANNER_SPEC } from '@/core/host/install/container-scanner.ts';

describe('container scanner distribution', () => {
  it.each([
    ['linux', 'x86-64', 'x64', 'bin', ''],
    ['linux', 'arm64', 'arm64', 'bin', ''],
    ['macos', 'arm64', 'arm64', 'bin', ''],
    ['windows', 'x86-64', 'x64', 'exe', '.exe'],
  ])(
    'resolves the signed %s %s artifact and keeps its local cache name',
    (os, arch, downloadArch, suffix, extension) => {
      const platform = { os, arch, extension };
      const artifact = resolveBinaryArtifact(CONTAINER_SCANNER_SPEC, platform);
      const artifactKey = `${os}-${downloadArch}`;
      expect(artifact.platform.arch).toBe(downloadArch);
      expect(artifact.url).toEndWith(
        `/CommercialDistribution/sonar-container-scanner/sonar-container-scanner-1.0.0.10227-${artifactKey}.${suffix}`,
      );
      expect(CONTAINER_SCANNER_SPEC.signatures[artifactKey]).toStartWith(
        '-----BEGIN PGP SIGNATURE-----',
      );
      expect(buildLocalBinaryName(CONTAINER_SCANNER_SPEC, platform)).toBe(
        `sonar-container-scanner-1.0.0.10227-${os}-${arch}${extension}`,
      );
    },
  );
});
