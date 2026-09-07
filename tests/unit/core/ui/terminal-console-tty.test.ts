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

// TTY rendering tests for TerminalConsole.blank()

import { describe, expect, it, spyOn } from 'bun:test';

void mock.module('@/core/ui/colors.js', mockColorsTTY);

import { mock } from 'bun:test';

import { setMockUi } from '@/core/ui/mock.ts';
import { TerminalConsole } from '@/core/ui/terminal-console.ts';

import { mockColorsTTY } from '../../../_common/colors-mock.ts';

describe('TerminalConsole: TTY blank', () => {
  it('writes a newline to stdout when isTTY is true', () => {
    setMockUi(false);
    const terminal = new TerminalConsole();
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.blank();
      expect(output).toContain('\n');
    } finally {
      spy.mockRestore();
    }
  });
});
