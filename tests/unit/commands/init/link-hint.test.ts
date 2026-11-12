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

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from 'bun:test';

import { createCommandTree } from '@/commands/command-tree.ts';
import { linkCommand, linkCommandFor } from '@/commands/init/steps/mapping.ts';
import * as gitWorktree from '@/core/host/git/worktree.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

function posixWords(command: string): string[] {
  return [...command.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map(([, quoted, bare]) =>
    quoted === undefined ? bare : quoted.replaceAll(String.raw`'\''`, "'"),
  );
}

function parseWithLinkCommand(hint: string): {
  operands: string[];
  unknown: string[];
  path: string | undefined;
  monorepo: boolean | undefined;
} {
  const words = posixWords(hint);
  expect(words.slice(0, 2)).toEqual(['sonar', 'link']);
  const link = createCommandTree({ console: new FakeConsole() }).commands.find(
    (command) => command.name() === 'link',
  );
  if (!link) {
    throw new Error('the link command is not registered');
  }
  const { operands, unknown } = link.parseOptions(words.slice(2));
  const { path, monorepo } = link.opts<{ path?: string; monorepo?: boolean }>();
  return { operands, unknown, path, monorepo };
}

describe.skipIf(process.platform === 'win32')('linkCommand', () => {
  it('is accepted by `sonar link` for a project at the root, which needs no --path', () => {
    // With a key, `sonar link` links the repository root when --path is absent.
    expect(parseWithLinkCommand(linkCommand('my_key', '.', undefined))).toEqual({
      operands: ['my_key'],
      unknown: [],
      path: undefined,
      monorepo: undefined,
    });
  });

  it('is accepted by `sonar link` for a nested project', () => {
    expect(parseWithLinkCommand(linkCommand('my_key', 'services/api', undefined))).toEqual({
      operands: ['my_key'],
      unknown: [],
      path: 'services/api',
      monorepo: undefined,
    });
  });

  it('keeps a path with spaces and quotes as one argument', () => {
    const path = "my app/it's";
    expect(parseWithLinkCommand(linkCommand('my_key', path, undefined))).toEqual({
      operands: ['my_key'],
      unknown: [],
      path,
      monorepo: undefined,
    });
  });

  it('prefixes the directory to run from', () => {
    expect(linkCommand('my_key', '.', '/work/repo')).toBe('cd /work/repo && sonar link my_key');
  });

  it('adds --monorepo when other folders are linked, so they are kept', () => {
    expect(parseWithLinkCommand(linkCommand('my_key', 'services/api', undefined, true))).toEqual({
      operands: ['my_key'],
      unknown: [],
      path: 'services/api',
      monorepo: true,
    });
  });
});

describe('linkCommandFor', () => {
  let dir: string;
  let gitRootSpy: Mock<typeof gitWorktree.resolveGitRepoRoot>;
  const server = { serverUrl: 'https://sq.example' };

  beforeEach(() => {
    dir = canonicalizePath(mkdtempSync(join(tmpdir(), 'link-hint-')));
    gitRootSpy = spyOn(gitWorktree, 'resolveGitRepoRoot').mockResolvedValue(dir);
    mkdirSync(join(dir, 'app'));
    mkdirSync(join(dir, 'other'));
  });

  afterEach(() => {
    gitRootSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function linked(...paths: string[]): void {
    const entries = paths.map((path) => ({ ...server, projectKey: `key_${path}`, path }));
    writeFileSync(join(dir, '.sonar-config.json'), JSON.stringify({ projects: entries }));
  }

  const hint = () => linkCommandFor('my_key', join(dir, 'app'));

  it('suggests a plain link when nothing is linked yet', async () => {
    expect(await hint()).toBe('sonar link my_key --path app');
  });

  it('suggests a plain link when only the same folder is linked', async () => {
    linked('app');

    expect(await hint()).toBe('sonar link my_key --path app');
  });

  it('adds --monorepo when a single link names another folder', async () => {
    linked('other');

    expect(await hint()).toBe('sonar link --monorepo my_key --path app');
  });

  it('adds --monorepo when several folders are linked', async () => {
    linked('app', 'other');

    expect(await hint()).toBe('sonar link --monorepo my_key --path app');
  });
});
