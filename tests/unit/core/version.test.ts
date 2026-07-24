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

import { Version } from '@/core/version.ts';

describe('Version', () => {
  it('exposes the full version and derived major.minor.patch version', () => {
    const version = new Version('1.2.3.456');

    expect(version.text).toBe('1.2.3.456');
    expect(version.noBuild).toBeInstanceOf(Version);
    expect(version.noBuild.text).toBe('1.2.3');
  });

  it('stringifies to the full version', () => {
    expect(String(new Version('1.2.3.456'))).toBe('1.2.3.456');
  });

  it('returns true when this version has a newer version', () => {
    const current = new Version('1.2.3');
    const latest = new Version('1.3.0.456');

    expect(latest.isNewerThan(current)).toBe(true);
  });

  it('considers build-number differences when comparing full versions', () => {
    const current = new Version('1.2.3');
    const latest = new Version('1.2.3.456');

    expect(latest.isNewerThan(current)).toBe(true);
  });
});
