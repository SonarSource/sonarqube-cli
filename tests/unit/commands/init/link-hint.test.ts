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

import { createCommandTree } from '@/commands/command-tree.ts';
import { linkCommand } from '@/commands/init/steps/mapping.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

function posixWords(command: string): string[] {
  return [...command.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map(([, quoted, bare]) =>
    quoted === undefined ? bare : quoted.replaceAll(String.raw`'\''`, "'"),
  );
}

function parseWithLinkCommand(hint: string): {
  operands: string[];
  unknown: string[];
  path: string;
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
  return { operands, unknown, path: link.opts<{ path: string }>().path };
}

describe.skipIf(process.platform === 'win32')('linkCommand', () => {
  it('is accepted by `sonar link` for a project at the root', () => {
    expect(parseWithLinkCommand(linkCommand('my_key', '.', undefined))).toEqual({
      operands: ['my_key'],
      unknown: [],
      path: '.',
    });
  });

  it('is accepted by `sonar link` for a nested project', () => {
    expect(parseWithLinkCommand(linkCommand('my_key', 'services/api', undefined))).toEqual({
      operands: ['my_key'],
      unknown: [],
      path: 'services/api',
    });
  });

  it('keeps a path with spaces and quotes as one argument', () => {
    const path = "my app/it's";
    expect(parseWithLinkCommand(linkCommand('my_key', path, undefined))).toEqual({
      operands: ['my_key'],
      unknown: [],
      path,
    });
  });

  it('adds --monorepo, which `sonar link` accepts, for a root of a monorepo', () => {
    const hint = linkCommand('my_key', 'services/api', undefined, true);

    expect(hint).toBe('sonar link my_key --path services/api --monorepo');
    const link = createCommandTree({ console: new FakeConsole() }).commands.find(
      (command) => command.name() === 'link',
    );
    const { unknown } = link!.parseOptions(posixWords(hint).slice(2));
    expect(unknown).toEqual([]);
    expect(link!.opts<{ monorepo: boolean }>().monorepo).toBe(true);
  });

  it('prefixes the directory to run from', () => {
    expect(linkCommand('my_key', '.', '/work/repo')).toBe('cd /work/repo && sonar link my_key');
  });
});
