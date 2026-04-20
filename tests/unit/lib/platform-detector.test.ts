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

import { detectPlatform } from '../../../src/lib/platform-detector';

describe('platform-detector', () => {
  describe('detectPlatform', () => {
    it('should detect current platform', () => {
      const platform = detectPlatform();
      expect(platform.os).toBeDefined();
      expect(platform.arch).toBeDefined();
      expect(platform.extension).toBeDefined();
    });

    it('should have valid os value', () => {
      const platform = detectPlatform();
      expect(['linux', 'macos', 'windows']).toContain(platform.os);
    });

    it('should have valid arch value', () => {
      const platform = detectPlatform();
      expect(['x86-64', 'arm64', 'arm', '386']).toContain(platform.arch);
    });

    it('should have correct extension for current platform', () => {
      const platform = detectPlatform();
      if (platform.os === 'windows') {
        expect(platform.extension).toBe('.exe');
      } else {
        expect(platform.extension).toBe('');
      }
    });
  });
});
