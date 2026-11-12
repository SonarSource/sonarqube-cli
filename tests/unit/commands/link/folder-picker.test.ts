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

import type { TreeNode, TreePromptOptions } from '@/core/ui/tree/tree-source.ts';

import { TreeFolderPicker } from '../../../../src/commands/link/folder-picker.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';

describe('TreeFolderPicker', () => {
  let root: string;
  let fake: FakeConsole;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folder-picker-'));
    fake = new FakeConsole();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the root without prompting when it has no folders', async () => {
    expect(await new TreeFolderPicker(fake).pick(root, { message: 'Pick' })).toEqual([root]);
    expect(fake.calls.find((c) => c.method === 'treeMultiSelectPrompt')).toBeUndefined();
  });

  it('returns null when the user cancels', async () => {
    mkdirSync(join(root, 'web'));
    fake.queueResponse(null);

    expect(await new TreeFolderPicker(fake).pick(root, { message: 'Pick' })).toBeNull();
  });

  it('returns the ticked folders, showing notes and leaving hidden folders out', async () => {
    mkdirSync(join(root, 'services', 'api'), { recursive: true });
    mkdirSync(join(root, '.cache'));
    fake.queueResponse({ paths: [['root', 'services', 'api'], ['root']] });
    let shown: TreePromptOptions<string> | undefined;
    const prompt = fake.treeMultiSelectPrompt.bind(fake);
    fake.treeMultiSelectPrompt = <T>(message: string, options: TreePromptOptions<T>) => {
      shown = options as unknown as TreePromptOptions<string>;
      return prompt(message, options);
    };

    const picked = await new TreeFolderPicker(fake).pick(root, {
      message: 'Pick',
      rootLabel: 'root',
      annotate: (folder) => (folder === join(root, 'services') ? 'note' : undefined),
    });

    expect(picked).toEqual([join(root, 'services', 'api'), root]);
    const children: TreeNode<string>[] = shown?.roots[0].children ?? [];
    expect(children.map((node) => [node.label, node.detail])).toEqual([['services', 'note']]);
  });

  it('marks folders without subfolders as leaves, and caps annotated search results at 50', async () => {
    mkdirSync(join(root, 'nested', 'inner'), { recursive: true });
    for (let i = 0; i < 60; i++) mkdirSync(join(root, `f${i}`));
    let shown: TreePromptOptions<string> | undefined;
    fake.treeMultiSelectPrompt = <T>(_message: string, options: TreePromptOptions<T>) => {
      shown = options as unknown as TreePromptOptions<string>;
      return Promise.resolve(null);
    };

    await new TreeFolderPicker(fake).pick(root, { message: 'Pick', annotate: () => 'note' });

    const children = shown?.roots[0].children ?? [];
    expect(children.find((node) => node.label === 'nested')?.leaf).toBe(false);
    expect(children.find((node) => node.label === 'f0')?.leaf).toBe(true);
    const results = await shown?.search?.('f');
    expect(results?.total).toBe(60);
    expect(results?.options).toHaveLength(50);
    expect(results?.options.every((option) => option.detail === 'note')).toBe(true);
  });
});
