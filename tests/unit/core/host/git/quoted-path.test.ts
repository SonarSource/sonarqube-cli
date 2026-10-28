/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { decodeGitPath } from '@/core/host/git/quoted-path.ts';

describe('decodeGitPath', () => {
  it.each([
    ['src/plain.ts', 'src/plain.ts'],
    ['', ''],
    ['"', '"'],
  ])('leaves %p alone when there is nothing to decode', (input, expected) => {
    expect(decodeGitPath(input)).toBe(expected);
  });

  it.each([
    ['"caf\\303\\251.txt"', 'café.txt'],
    ['"\\346\\227\\245\\346\\234\\254.txt"', '日本.txt'],
    ['"\\360\\237\\224\\221.key"', '🔑.key'],
  ])(
    'decodes %p as a UTF-8 byte sequence rather than character by character',
    (input, expected) => {
      expect(decodeGitPath(input)).toBe(expected);
    },
  );

  it.each([
    ['"we\\"ird.txt"', 'we"ird.txt'],
    ['"back\\\\slash.txt"', 'back\\slash.txt'],
    ['"tab\\there.txt"', 'tab\there.txt'],
    ['"new\\nline.txt"', 'new\nline.txt'],
    ['"carriage\\rreturn.txt"', 'carriage\rreturn.txt'],
    ['"bell\\aback\\bfeed\\fvtab\\v.txt"', 'bell\x07back\bfeed\fvtab\v.txt'],
  ])('decodes the escape in %p', (input, expected) => {
    expect(decodeGitPath(input)).toBe(expected);
  });

  it.each([
    ['"café\\there.txt"', 'café\there.txt'],
    ['"日\\there.txt"', '日\there.txt'],
    ['"🔑\\there.txt"', '🔑\there.txt'],
    ['"🔑🗝\\tx.txt"', '🔑🗝\tx.txt'],
    ['"x\\t🔑"', 'x\t🔑'],
    ['"🔑caf\\303\\251\\t.txt"', '🔑café\t.txt'],
  ])('decodes %p, whose bytes core.quotePath=false left literal', (input, expected) => {
    expect(decodeGitPath(input)).toBe(expected);
  });

  it.each([
    ['"\\377.txt"', 'a byte that cannot start a UTF-8 sequence'],
    ['"\\303.txt"', 'a truncated UTF-8 sequence'],
  ])('keeps %p as git printed it when the bytes do not decode (%s)', (input) => {
    expect(decodeGitPath(input)).toBe(input);
  });

  it.each([
    ['"unterminated.txt', 'no closing quote'],
    ['"bad\\9octal.txt"', 'an escape git never emits'],
    ['"short\\7.txt"', 'fewer than three octal digits'],
    ['"trailing\\"', 'a backslash where the closing quote should be'],
  ])('keeps %p as git printed it when the quoting is malformed (%s)', (input) => {
    expect(decodeGitPath(input)).toBe(input);
  });
});
