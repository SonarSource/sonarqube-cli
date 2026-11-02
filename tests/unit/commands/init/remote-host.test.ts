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

import { isBindableRemote, remoteRepositorySlug } from '@/commands/init/remote-host.ts';

describe('isBindableRemote', () => {
  it.each([
    'https://github.com/example/repository.git',
    'git@github.com:example/repository.git',
    'github.com:example/repository.git',
    'ssh://git@github.com/example/repository.git',
    'https://dev.azure.com/org/project/_git/repository',
    'git@ssh.dev.azure.com:v3/org/project/repository',
    'https://org.visualstudio.com/project/_git/repository',
    'https://GitHub.com/example/repository.git',
  ])('accepts %s', (remote) => {
    expect(isBindableRemote(remote)).toBe(true);
  });

  it.each([
    'https://gitlab.com/example/repository.git',
    'git@bitbucket.org:example/repository.git',
    'https://github.example.com/example/repository.git',
    'gitlab.com:example/repository.git',
    'https://evilvisualstudio.com/project/_git/repository',
    '/local/path/to/repository',
    '',
  ])('rejects %s', (remote) => {
    expect(isBindableRemote(remote)).toBe(false);
  });
});

describe('remoteRepositorySlug', () => {
  it.each([
    ['https://github.com/example/repository.git', 'example/repository'],
    ['git@github.com:example/repository.git', 'example/repository'],
    ['github.com:example/repository.git', 'example/repository'],
    ['https://dev.azure.com/org/project/_git/repository', 'project/repository'],
    ['https://org@dev.azure.com/org/project/_git/repository', 'project/repository'],
    ['git@ssh.dev.azure.com:v3/org/project/repository', 'project/repository'],
    ['ssh://git@ssh.dev.azure.com/v3/org/project/repository', 'project/repository'],
    ['https://org.visualstudio.com/project/_git/repository', 'project/repository'],
    [
      'https://org.visualstudio.com/DefaultCollection/project/_git/repository',
      'project/repository',
    ],
    ['org@vs-ssh.visualstudio.com:v3/org/project/repository', 'project/repository'],
    ['https://dev.azure.com/org/project', null],
    ['https://github.com/example', null],
    ['https://gitlab.com/example/repository.git', null],
    ['', null],
  ])('maps %s to %s', (remote, slug) => {
    expect(remoteRepositorySlug(remote)).toBe(slug);
  });
});
