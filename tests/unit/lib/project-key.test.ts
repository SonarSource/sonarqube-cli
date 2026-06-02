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

import { isValidProjectKey } from '../../../src/lib/project-key';

describe('isValidProjectKey', () => {
  it('accepts valid keys', () => {
    expect(isValidProjectKey('my-project')).toBe(true);
    expect(isValidProjectKey('org:project')).toBe(true);
    expect(isValidProjectKey('proj_1.0')).toBe(true);
    expect(isValidProjectKey('A')).toBe(true);
    expect(isValidProjectKey('a'.repeat(400))).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidProjectKey('')).toBe(false);
  });

  it('rejects keys exceeding 400 characters', () => {
    expect(isValidProjectKey('a'.repeat(401))).toBe(false);
  });

  it('rejects keys with disallowed characters', () => {
    expect(isValidProjectKey('proj ect')).toBe(false);
    expect(isValidProjectKey('proj/ect')).toBe(false);
    expect(isValidProjectKey('proj@ect')).toBe(false);
    expect(isValidProjectKey('proj#ect')).toBe(false);
    expect(isValidProjectKey("proj'ect")).toBe(false);
  });
});
