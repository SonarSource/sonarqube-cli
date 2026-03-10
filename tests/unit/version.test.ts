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
import { isNewerVersion, stripBuildNumber } from '../../src/lib/version';

describe('isNewerVersion', () => {
  it('returns true when candidate has a higher major', () => {
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(true);
  });

  it('returns true when candidate has a higher minor', () => {
    expect(isNewerVersion('1.2.0', '1.3.0')).toBe(true);
  });

  it('returns true when candidate has a higher patch', () => {
    expect(isNewerVersion('1.2.3', '1.2.4')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  });

  it('returns false when current is higher', () => {
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(false);
  });

  it('handles four-segment versions', () => {
    expect(isNewerVersion('1.2.3.0', '1.2.3.1')).toBe(true);
    expect(isNewerVersion('1.2.3.1', '1.2.3.0')).toBe(false);
  });

  it('treats a missing segment as 0', () => {
    expect(isNewerVersion('1.2.3', '1.2.3.0')).toBe(false);
    expect(isNewerVersion('1.2.3', '1.2.3.1')).toBe(true);
  });
});

describe('stripBuildNumber', () => {
  it('removes the 4th segment from a version with a build number', () => {
    expect(stripBuildNumber('0.5.0.241')).toBe('0.5.0');
  });

  it('leaves a 3-segment version unchanged', () => {
    expect(stripBuildNumber('1.2.3')).toBe('1.2.3');
  });

  it('leaves a 2-segment version unchanged', () => {
    expect(stripBuildNumber('1.2')).toBe('1.2');
  });
});
