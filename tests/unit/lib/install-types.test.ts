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
    it.each([
      ['linux', 'x86-64', '', '-linux-x86-64'],
      ['windows', 'x86-64', '.exe', '-windows-x86-64.exe'],
      ['macos', 'arm64', '', '-macos-arm64'],
    ] as const)('%s/%s%s → %s', (os, arch, extension, expected) => {
      expect(buildPlatformSuffix({ os, arch, extension })).toBe(expected);
    });
  });

  describe('buildCagPlatformSuffix (sonar-context-augmentation convention)', () => {
    it.each([
      ['linux', 'x86-64', '', 'alpine-x64'],
      ['windows', 'x86-64', '.exe', 'windows-x64'],
      ['linux', 'arm64', '', 'alpine-arm64'],
      ['macos', 'arm64', '', 'macos-arm64'],
    ] as const)('%s/%s%s → %s', (os, arch, extension, expected) => {
      expect(buildCagPlatformSuffix({ os, arch, extension })).toBe(expected);
    });
  });
});
