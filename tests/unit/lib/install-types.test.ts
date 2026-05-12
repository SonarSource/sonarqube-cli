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

import { buildCagPlatformSuffix, buildPlatformSuffix } from '../../../src/lib/install-types';

describe('install-types', () => {
  describe('buildPlatformSuffix (sonar-secrets convention)', () => {
    it('preserves x86-64 and includes a leading dash and extension', () => {
      expect(buildPlatformSuffix({ os: 'linux', arch: 'x86-64', extension: '' })).toBe(
        '-linux-x86-64',
      );
      expect(buildPlatformSuffix({ os: 'windows', arch: 'x86-64', extension: '.exe' })).toBe(
        '-windows-x86-64.exe',
      );
      expect(buildPlatformSuffix({ os: 'macos', arch: 'arm64', extension: '' })).toBe(
        '-macos-arm64',
      );
    });
  });

  describe('buildCagPlatformSuffix (sonar-context-augmentation convention)', () => {
    it('routes linux to alpine and rewrites x86-64 to x64', () => {
      expect(buildCagPlatformSuffix({ os: 'linux', arch: 'x86-64', extension: '' })).toBe(
        'alpine-x64',
      );
      expect(buildCagPlatformSuffix({ os: 'windows', arch: 'x86-64', extension: '.exe' })).toBe(
        'windows-x64',
      );
    });

    it('keeps arm64 unchanged but still routes linux to alpine', () => {
      expect(buildCagPlatformSuffix({ os: 'linux', arch: 'arm64', extension: '' })).toBe(
        'alpine-arm64',
      );
      expect(buildCagPlatformSuffix({ os: 'macos', arch: 'arm64', extension: '' })).toBe(
        'macos-arm64',
      );
    });
  });
});
