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

import {
  formatIgnoredHeader,
  formatProjectHeader,
} from '@/commands/analyze/sqaa-display-headers.ts';

describe('formatProjectHeader', () => {
  it('names the project with its file and issue counts', () => {
    expect(formatProjectHeader('app-a', 2, 5, false)).toBe('app-a · 2 files · 5 issues');
  });

  it('uses the singular for a count of one', () => {
    expect(formatProjectHeader('app-a', 1, 1, false)).toBe('app-a · 1 file · 1 issue');
  });

  it('keeps the plural for a count of zero', () => {
    expect(formatProjectHeader('app-a', 3, 0, false)).toBe('app-a · 3 files · 0 issues');
  });
});

describe('formatIgnoredHeader', () => {
  it('counts the files owned by no project', () => {
    expect(formatIgnoredHeader(2, false)).toBe('Not analyzed · 2 files');
  });

  it('uses the singular for a single file', () => {
    expect(formatIgnoredHeader(1, false)).toBe('Not analyzed · 1 file');
  });
});
