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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import {
  InvalidLinkPathError,
  linkProjectDirectories,
  relativeProjectPath,
  resolveLinkTarget,
} from '@/core/project-discovery/link-target.ts';

let dir: string;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

beforeEach(() => {
  dir = canonicalizePath(mkdtempSync(join(tmpdir(), 'link-target-')));
  mkdirSync(join(dir, 'services', 'api'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveLinkTarget', () => {
  it('falls back to the start directory outside a git repository', async () => {
    const target = await resolveLinkTarget(dir, 'services/api');

    expect(target).toEqual({
      targetDir: dir,
      projectRoot: join(dir, 'services', 'api'),
      inGitRepository: false,
    });
  });

  it('rejects a path that escapes the config directory', async () => {
    mkdirSync(join(dir, 'repo'));
    expect(await rejection(resolveLinkTarget(join(dir, 'repo'), '../services'))).toBeInstanceOf(
      InvalidLinkPathError,
    );
  });

  it('rejects a path that does not exist', async () => {
    expect(await rejection(resolveLinkTarget(dir, 'missing'))).toBeInstanceOf(InvalidLinkPathError);
  });
});

describe('relativeProjectPath', () => {
  it('uses forward slashes and "." for the directory itself', () => {
    expect(relativeProjectPath(dir, join(dir, 'services', 'api'))).toBe('services/api');
    expect(relativeProjectPath(dir, dir)).toBe('.');
  });
});

describe('linkProjectDirectories', () => {
  const auth = new ResolvedAuth({
    token: 't',
    serverUrl: 'https://sq.example.com',
    connectionType: 'on-premise',
    source: 'state',
  });
  const link = (key: string, subdir: string, mode: 'merge' | 'replace') =>
    linkProjectDirectories(auth, dir, [{ projectKey: key, projectRoot: join(dir, subdir) }], mode);
  const written = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, '.sonar-config.json'), 'utf8')) as Record<string, unknown>;
  const entry = (projectKey: string, path: string) => ({
    projectKey,
    path,
    serverUrl: auth.serverUrl,
  });

  it('reports the mapping it replaced for the same directory', async () => {
    await link('first', '.', 'replace');

    expect(await link('second', '.', 'replace')).toEqual({
      replacedProjectKeys: ['first'],
      removedProjectKeys: [],
      linkedCount: 1,
    });
  });

  it('stores the path relative to the config directory', async () => {
    await link('api', 'services/api', 'replace');

    expect(written().project).toMatchObject({ projectKey: 'api', path: 'services/api' });
  });

  it('merges into what is linked, switching to a projects array past one project', async () => {
    await link('root', '.', 'merge');
    expect(written()).toEqual({ project: entry('root', '.') });

    expect(await link('api', 'services/api', 'merge')).toMatchObject({ linkedCount: 2 });
    expect(written()).toEqual({ projects: [entry('root', '.'), entry('api', 'services/api')] });
  });

  it('keeps a merged mapping in its place when its directory is linked again', async () => {
    await link('root', '.', 'merge');
    await link('api', 'services/api', 'merge');
    await link('root2', '.', 'merge');

    expect(written()).toEqual({ projects: [entry('root2', '.'), entry('api', 'services/api')] });
  });

  it('leaves only the new link when replacing, and reports the mappings it removed', async () => {
    writeFileSync(
      join(dir, '.sonar-config.json'),
      JSON.stringify({ projects: [entry('root', '.'), entry('api', 'services/api')] }),
    );

    expect(await link('mine', '.', 'replace')).toEqual({
      replacedProjectKeys: ['root'],
      removedProjectKeys: ['api'],
      linkedCount: 1,
    });
    expect(written()).toEqual({ project: entry('mine', '.') });
  });
});
