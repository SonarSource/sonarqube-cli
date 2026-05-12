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

import { buildCagDownloadUrl, buildDownloadUrl } from '../../../src/lib/sonarsource-releases';

describe('sonarsource-releases', () => {
  describe('buildDownloadUrl (sonar-secrets convention)', () => {
    it('builds <prefix>/<name>-<ver>-<plat>.exe', () => {
      const url = buildDownloadUrl(
        'sonar-secrets',
        '2.41.0.10709',
        'CommercialDistribution/sonar-secrets',
        { os: 'macos', arch: 'arm64', extension: '' },
      );
      expect(url).toContain('CommercialDistribution/sonar-secrets/');
      expect(url.endsWith('sonar-secrets-2.41.0.10709-macos-arm64.exe')).toBe(true);
    });
  });

  describe('buildCagDownloadUrl (sonar-context-augmentation convention)', () => {
    it('routes linux to the alpine artifact and maps x86-64 -> x64', () => {
      const url = buildCagDownloadUrl('0.9.0.355', {
        os: 'linux',
        arch: 'x86-64',
        extension: '',
      });
      expect(url).toContain('Distribution/sonar-context-augmentation-alpine-x64/');
      expect(url.endsWith('sonar-context-augmentation-alpine-x64-0.9.0.355.tar.gz')).toBe(true);
    });

    it('keeps arm64 unchanged for macOS', () => {
      const url = buildCagDownloadUrl('0.9.0.355', {
        os: 'macos',
        arch: 'arm64',
        extension: '',
      });
      expect(url).toContain('Distribution/sonar-context-augmentation-macos-arm64/');
      expect(url.endsWith('sonar-context-augmentation-macos-arm64-0.9.0.355.tar.gz')).toBe(true);
    });
  });
});
