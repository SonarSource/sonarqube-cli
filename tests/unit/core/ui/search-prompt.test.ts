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

import { highlightMatches, truncate } from '@/core/ui/search-prompt.ts';

const tag = (s: string): string => `<${s}>`;
const plain = (s: string): string => s;

describe('highlightMatches', () => {
  it('marks every case-insensitive occurrence and keeps the original casing', () => {
    expect(highlightMatches('Mobile-mob', 'MOB', plain, tag)).toBe('<Mob>ile-<mob>');
  });

  it('leaves the text alone for an empty or blank query', () => {
    expect(highlightMatches('abc', '  ', tag, plain)).toBe('<abc>');
  });

  it('paints the non-matching parts with the base style', () => {
    expect(highlightMatches('a-mob-b', 'mob', tag, (s) => s.toUpperCase())).toBe('<a->MOB<-b>');
  });
});

describe('truncate', () => {
  it('keeps text that fits', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('ends a cut text in an ellipsis within the width', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
  });

  it('returns nothing for a non-positive width', () => {
    expect(truncate('abc', 0)).toBe('');
  });
});
