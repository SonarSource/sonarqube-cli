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

import { deriveProjectKey } from '@/commands/import/server/project-key.ts';

describe('deriveProjectKey', () => {
  it('turns a nested path into an underscore-separated key', () => {
    expect(deriveProjectKey('group/subgroup/repo')).toBe('group_subgroup_repo');
  });

  it('keeps the characters a project key allows', () => {
    expect(deriveProjectKey('my-group/repo.v2:main_x')).toBe('my-group_repo.v2:main_x');
  });

  it('replaces every other character', () => {
    expect(deriveProjectKey('group/my repo (old)')).toBe('group_my_repo__old_');
  });

  it('avoids an all-digit key, which SonarQube rejects', () => {
    expect(deriveProjectKey('12345')).toBe('repo_12345');
  });

  it('caps the key at 400 characters', () => {
    expect(deriveProjectKey('a'.repeat(500))).toHaveLength(400);
  });
});
