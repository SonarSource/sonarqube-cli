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

import { stripGitRemoteUrlUserinfo } from '@/core/server/git-remote-url.ts';

describe('stripGitRemoteUrlUserinfo', () => {
  it('removes username and password from https remotes', () => {
    expect(stripGitRemoteUrlUserinfo('https://user:token@github.com/foo/bar.git')).toBe(
      'https://github.com/foo/bar.git',
    );
  });

  it('removes username-only userinfo from https remotes', () => {
    expect(stripGitRemoteUrlUserinfo('https://user@github.com/foo/bar.git')).toBe(
      'https://github.com/foo/bar.git',
    );
  });

  it('returns the original string when there is no userinfo', () => {
    const remote = 'https://github.com/foo/bar.git';
    expect(stripGitRemoteUrlUserinfo(remote)).toBe(remote);
  });

  it('returns scp-style remotes unchanged', () => {
    const remote = 'git@github.com:foo/bar.git';
    expect(stripGitRemoteUrlUserinfo(remote)).toBe(remote);
  });
});
