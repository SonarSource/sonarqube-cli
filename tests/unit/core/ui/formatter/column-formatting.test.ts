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

import { columnFormatting, padColumns } from '@/core/ui/formatter/column-formatting.ts';

describe('columnFormatting', () => {
  it('uses the longest cell in each column', () => {
    expect(columnFormatting([['a', 'bbb'], ['cc']])).toEqual([3, 2]);
  });

  it('falls back to the floor when every cell is shorter than it', () => {
    expect(columnFormatting([['a', 'bb']], [10])).toEqual([10]);
  });

  it('uses actual content width when it exceeds the floor', () => {
    expect(columnFormatting([['a', 'longer than the floor']], [5])).toEqual([21]);
  });

  it('defaults missing floors to 0', () => {
    expect(columnFormatting([['a'], ['bb']])).toEqual([1, 2]);
  });

  it('returns 0 for an empty column with no floor', () => {
    expect(columnFormatting([[]])).toEqual([0]);
  });
});

describe('padColumns', () => {
  it('pads every cell in a column to that column widest cell', () => {
    expect(padColumns([['a', 'bbb', 'cc']])).toEqual([['a  ', 'bbb', 'cc ']]);
  });

  it('pads independently per column', () => {
    expect(
      padColumns([
        ['a', 'bbb'],
        ['xx', 'y'],
      ]),
    ).toEqual([
      ['a  ', 'bbb'],
      ['xx', 'y '],
    ]);
  });

  it('pads short content up to the floor', () => {
    expect(padColumns([['a']], [4])).toEqual([['a   ']]);
  });

  it('never truncates content longer than the floor', () => {
    expect(padColumns([['a long value']], [3])).toEqual([['a long value']]);
  });

  it('adds no extra gap by default', () => {
    expect(padColumns([['a', 'bbb']])).toEqual([['a'.padEnd(3), 'bbb']]);
  });

  it("adds the gap on top of the computed width for every cell, including the column's own longest one", () => {
    expect(padColumns([['a', 'bbb']], [0], 2)).toEqual([['a'.padEnd(5), 'bbb'.padEnd(5)]]);
  });

  it('adds the gap on top of a floor too', () => {
    expect(padColumns([['a']], [4], 2)).toEqual([['a'.padEnd(6)]]);
  });
});
