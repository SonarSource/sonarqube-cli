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

import { describe, it, expect } from 'bun:test';
import { buildDownloadUrl } from '../../src/lib/sonarsource-releases.js';
import {
  SONARSOURCE_BINARIES_URL,
  SONAR_SECRETS_DIST_PREFIX,
} from '../../src/lib/config-constants.js';

describe('sonarsource-releases', () => {
  describe('buildDownloadUrl', () => {
    it('always uses .exe suffix for Linux', () => {
      const url = buildDownloadUrl('1.2.3', { os: 'linux', arch: 'x86-64', extension: '' });
      expect(url).toEndWith('.exe');
    });

    it('always uses .exe suffix for macOS', () => {
      const url = buildDownloadUrl('1.2.3', { os: 'macos', arch: 'arm64', extension: '' });
      expect(url).toEndWith('.exe');
    });

    it('builds correct URL for Linux x86-64', () => {
      const url = buildDownloadUrl('1.2.3', { os: 'linux', arch: 'x86-64', extension: '' });
      expect(url).toBe(
        `${SONARSOURCE_BINARIES_URL}/${SONAR_SECRETS_DIST_PREFIX}/sonar-secrets-1.2.3-linux-x86-64.exe`,
      );
    });

    it('builds correct URL for macOS arm64', () => {
      const url = buildDownloadUrl('1.2.3', { os: 'macos', arch: 'arm64', extension: '' });
      expect(url).toBe(
        `${SONARSOURCE_BINARIES_URL}/${SONAR_SECRETS_DIST_PREFIX}/sonar-secrets-1.2.3-macos-arm64.exe`,
      );
    });

    it('builds correct URL for Windows x86-64', () => {
      const url = buildDownloadUrl('1.2.3', { os: 'windows', arch: 'x86-64', extension: '.exe' });
      expect(url).toBe(
        `${SONARSOURCE_BINARIES_URL}/${SONAR_SECRETS_DIST_PREFIX}/sonar-secrets-1.2.3-windows-x86-64.exe`,
      );
    });

    it('handles four-part version numbers', () => {
      const url = buildDownloadUrl('2.38.0.10279', { os: 'linux', arch: 'x86-64', extension: '' });
      expect(url).toContain('sonar-secrets-2.38.0.10279-linux-x86-64.exe');
    });
  });
});
