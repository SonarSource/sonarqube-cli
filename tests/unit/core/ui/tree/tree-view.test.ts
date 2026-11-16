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

import { stripAnsi } from '@/core/ui/colors.ts';
import { renderTreeView, renderWindow } from '@/core/ui/tree/tree-view.ts';
import type { TreeSnapshot } from '@/core/ui/tree/tree-view-model.ts';

const VIEWPORT = 12;

function window(count: number, cursor: number): string[] {
  return renderWindow(count, cursor, (i) => `row ${i}`, VIEWPORT).map((line) =>
    stripAnsi(line).trim(),
  );
}

describe('renderWindow', () => {
  it('shows every row of a list that fits', () => {
    expect(window(VIEWPORT, 5)).toEqual(Array.from({ length: VIEWPORT }, (_, i) => `row ${i}`));
  });

  it('pads a short list with blank lines up to the requested size', () => {
    expect(window(3, 0)).toEqual([
      'row 0',
      'row 1',
      'row 2',
      ...Array<string>(VIEWPORT - 3).fill(''),
    ]);
    expect(renderWindow(0, 0, () => 'never', 4)).toEqual(['', '', '', '']);
  });

  it('fits a long list into a smaller requested size', () => {
    const lines = renderWindow(40, 20, (i) => `row ${i}`, VIEWPORT - 1);

    expect(lines).toHaveLength(VIEWPORT - 1);
    expect(lines.map((line) => stripAnsi(line).trim())).toContain('row 20');
  });

  it('keeps a long list at the same height wherever the cursor is, so the prompt does not jump', () => {
    for (const count of [VIEWPORT + 1, VIEWPORT + 2, 40]) {
      for (let cursor = 0; cursor < count; cursor++) {
        const lines = window(count, cursor);
        expect(lines).toHaveLength(VIEWPORT);
        expect(lines).toContain(`row ${cursor}`);
        expect(lines.join('\n')).not.toContain(' 1 more');
      }
    }
  });

  it('counts the rows scrolled off above and below', () => {
    expect(window(13, 0).at(-1)).toBe('↓ 2 more');
    expect(window(13, 12)[0]).toBe('↑ 2 more');

    const middle = window(40, 20);
    expect(middle[0]).toMatch(/^↑ \d+ more$/);
    expect(middle.at(-1)).toMatch(/^↓ \d+ more$/);
  });
});

describe('renderTreeView', () => {
  const layout = { message: 'Pick', columns: 80, bodyHeight: 13, input: '█', noun: 'folders' };
  const entry = (label: string) => ({ depth: 0, marker: 'leaf' as const, checked: false, label });
  const snapshot = (overrides: Partial<TreeSnapshot<string>>): TreeSnapshot<string> => ({
    multiple: true,
    searching: false,
    entries: [entry('a'), entry('b')],
    cursor: 0,
    chosen: [],
    refused: false,
    ...overrides,
  });
  const lines = (s: TreeSnapshot<string>) => stripAnsi(renderTreeView(s, layout)).split('\n');

  it('keeps the same height for a short tree, a long one, and search results', () => {
    const many = Array.from({ length: 40 }, (_, i) => entry(`f${i}`));
    const search = { query: 'f', shown: 40, total: 182, loading: false, loaded: true };
    const heights = [
      lines(snapshot({})),
      lines(snapshot({ entries: many, cursor: 20 })),
      lines(snapshot({ searching: true, entries: many, search })),
      lines(snapshot({ searching: true, entries: [], search: { ...search, loading: true } })),
    ].map((frame) => frame.length);

    expect(new Set(heights)).toEqual(new Set([1 + 13 + 1]));
  });

  it('reports the selection, or the refusal in its place', () => {
    expect(lines(snapshot({ chosen: [{ value: 'a', label: 'a' }] }))).toContain('  1 selected');
    expect(lines(snapshot({ refused: true }))).toContain('  Select at least one with Tab.');
  });
});
