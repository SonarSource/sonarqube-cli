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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { canonicalizePath } from '@/core/io/fs-utils.ts';
import {
  InvalidLinkPathError,
  relativeProjectPath,
  resolveLinkTarget,
  saveProjectLink,
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

describe('saveProjectLink', () => {
  const entry = (projectKey: string, path = '.') => ({
    projectKey,
    path,
    serverUrl: 'https://sq.example.com',
  });

  it('reports the mapping it replaced for the same directory', async () => {
    await saveProjectLink(dir, entry('first'), { monorepo: false });

    const saved = await saveProjectLink(dir, entry('second'), { monorepo: false });

    expect(saved).toEqual({ replacedProjectKey: 'first', shadowed: false });
  });

  it('reports a singular project shadowed by a projects array', async () => {
    writeFileSync(
      join(dir, '.sonar-config.json'),
      JSON.stringify({ projects: [entry('other', 'services/api')] }),
    );

    const saved = await saveProjectLink(dir, entry('mine'), { monorepo: false });

    expect(saved.shadowed).toBe(true);
  });

  it('adds to the projects array in monorepo mode without shadowing', async () => {
    const saved = await saveProjectLink(dir, entry('api', 'services/api'), { monorepo: true });

    expect(saved).toEqual({ replacedProjectKey: undefined, shadowed: false });
  });
});
