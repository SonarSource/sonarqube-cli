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

import { describe, expect, it, spyOn } from 'bun:test';

import { channelStream, print, write } from '@/core/ui/streams.ts';

describe('streams', () => {
  it('channelStream maps stdout and stderr', () => {
    expect(channelStream('stdout')).toBe(process.stdout);
    expect(channelStream('stderr')).toBe(process.stderr);
  });

  it('write appends a newline', () => {
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      write(process.stdout, 'hello');
      expect(output.join('')).toBe('hello\n');
    } finally {
      spy.mockRestore();
    }
  });

  it('print writes to stdout with a trailing newline', () => {
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      print('raw line');
      expect(output.join('')).toBe('raw line\n');
    } finally {
      spy.mockRestore();
    }
  });

  it('print does not add an extra newline when the message already ends with one', () => {
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      print('line\n');
      expect(output.join('')).toBe('line\n');
    } finally {
      spy.mockRestore();
    }
  });

  it('print writes to stderr when requested', () => {
    const output: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      print('stderr line', 'stderr');
      expect(output.join('')).toBe('stderr line\n');
    } finally {
      spy.mockRestore();
    }
  });
});
