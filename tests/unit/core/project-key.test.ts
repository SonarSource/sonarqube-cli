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

import { isValidProjectKey } from '@/core/project-key.ts';

describe('isValidProjectKey', () => {
  it.each(['my-project', 'org_repo.v1:x', '1a', 'a1'])('accepts %p', (key) => {
    expect(isValidProjectKey(key)).toBe(true);
  });

  it.each(['', '123', 'has space', 'semi;colon', 'a'.repeat(401)])('rejects %p', (key) => {
    expect(isValidProjectKey(key)).toBe(false);
  });

  it('accepts a key of exactly 400 characters', () => {
    expect(isValidProjectKey('a'.repeat(400))).toBe(true);
  });
});
