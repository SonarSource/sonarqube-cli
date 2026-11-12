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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { listAllFolders, matchFolders } from '../../../../src/commands/link/folder-search.ts';

describe('listAllFolders', () => {
  it('lists folders breadth-first, keeping empty ones and leaving hidden ones out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folder-search-'));
    try {
      mkdirSync(join(root, 'services', 'api'), { recursive: true });
      mkdirSync(join(root, 'empty'));
      mkdirSync(join(root, '.cache', 'deep'), { recursive: true });
      writeFileSync(join(root, 'services', 'api', 'a.ts'), '');

      expect((await listAllFolders(root)).sort()).toEqual(['empty', 'services', 'services/api']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('matchFolders', () => {
  const folders = [
    'apps',
    'apps/web-app',
    'services',
    'services/api',
    'services/api/app',
    'My App',
  ];

  it('matches the folder name only, case-insensitively, shallowest first', () => {
    expect(matchFolders(folders, 'APP')).toEqual([
      'apps',
      'My App',
      'apps/web-app',
      'services/api/app',
    ]);
  });

  it('ignores whitespace in both the query and the names', () => {
    expect(matchFolders(folders, 'myapp')).toEqual(['My App']);
    expect(matchFolders(folders, 'my app')).toEqual(['My App']);
  });

  it('does not match a parent folder name', () => {
    expect(matchFolders(folders, 'services')).toEqual(['services']);
  });
});
