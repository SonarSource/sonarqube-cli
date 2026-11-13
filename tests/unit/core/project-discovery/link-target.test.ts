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

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import {
  InvalidLinkPathError,
  linkItem,
  relativeProjectPath,
  resolveLinkTarget,
  withLink,
} from '@/core/project-discovery/link-target.ts';
import type {
  ConfigItem,
  SharedProjectConfigEntry,
} from '@/core/project-discovery/shared-project-config.ts';

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

describe('linkItem and withLink', () => {
  const auth = new ResolvedAuth({
    token: 't',
    serverUrl: 'https://sq.example.com',
    connectionType: 'on-premise',
    source: 'state',
  });
  const item = (key: string, subdir: string) => linkItem(auth, dir, join(dir, subdir), key);

  it('derives the entry from the connection, with the path relative to the config directory', () => {
    expect(item('api', 'services/api')).toEqual({
      entry: { projectKey: 'api', path: 'services/api', serverUrl: auth.serverUrl },
      root: join(dir, 'services', 'api'),
    });
  });

  it('replaces the item for the same folder in its place and appends a new folder', () => {
    const root = item('root', '.');
    const api = item('api', 'services/api');

    expect(withLink([root, api], item('root2', '.'))).toEqual([item('root2', '.'), api]);
    expect(withLink([root], api)).toEqual([root, api]);
  });

  it('keeps the fields outside the schema of the item it replaces, replacing the rest', () => {
    const settings = { 'sonar.cfamily.compile-commands': 'build/compile_commands.json' };
    const cloud = { projectKey: 'api', path: 'services/api', region: 'eu', organization: 'org' };
    const existing: ConfigItem = {
      entry: { ...cloud, settings } as SharedProjectConfigEntry,
      root: join(dir, 'services', 'api'),
    };

    const [updated] = withLink([existing], item('api2', 'services/api'));

    expect(updated.entry as unknown).toEqual({
      projectKey: 'api2',
      path: 'services/api',
      serverUrl: auth.serverUrl,
      settings,
    });
    expect(updated.root).toBe(join(dir, 'services', 'api'));
  });
});
