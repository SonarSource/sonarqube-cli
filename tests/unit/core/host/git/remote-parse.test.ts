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

import { parseGitRemote } from '@/core/host/git/remote-parse.ts';

describe('parseGitRemote', () => {
  it.each([
    ['https://GitHub.com/org/repo.git', { host: 'github.com', path: '/org/repo' }],
    ['git@github.com:org/repo.git', { host: 'github.com', path: '/org/repo' }],
    ['github.com:org/repo', { host: 'github.com', path: '/org/repo' }],
    ['ssh://git@host.example:2222/org/repo.git', { host: 'host.example', path: '/org/repo' }],
  ])('parses %s', (remote, expected) => {
    expect(parseGitRemote(remote)).toEqual(expected);
  });

  it.each(['', 'not a remote', 'C:\\repos\\project', 'C:/repos/project', 'file:///tmp/repo'])(
    'returns null for %p',
    (remote) => {
      expect(parseGitRemote(remote)).toBeNull();
    },
  );
});
