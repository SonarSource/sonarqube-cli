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

import { derivePassthroughSubcommand } from '../../../../../src/cli/commands/context';

describe('derivePassthroughSubcommand', () => {
  it('returns null when no action and no args (bare `sonar context`)', () => {
    expect(derivePassthroughSubcommand(undefined, [])).toBeNull();
  });

  it('returns the action when only an action is provided', () => {
    expect(derivePassthroughSubcommand('status', [])).toBe('status');
  });

  it('joins leading positional args with the action', () => {
    expect(derivePassthroughSubcommand('tool', ['stop'])).toBe('tool stop');
  });

  it('stops at the first flag and never captures option values', () => {
    expect(derivePassthroughSubcommand('tool', ['stop', '--all'])).toBe('tool stop');
    expect(derivePassthroughSubcommand('get-source', ['--file', 'secret.ts', '--line', '42'])).toBe(
      'get-source',
    );
  });

  it('also stops at short flags', () => {
    expect(derivePassthroughSubcommand('get-source', ['-f', 'secret.ts'])).toBe('get-source');
  });

  it('maps --help / -h to "help"', () => {
    expect(derivePassthroughSubcommand('--help', [])).toBe('help');
    expect(derivePassthroughSubcommand('-h', [])).toBe('help');
    expect(derivePassthroughSubcommand(undefined, ['--help'])).toBe('help');
    expect(derivePassthroughSubcommand(undefined, ['-h'])).toBe('help');
  });

  it('returns null when only option flags are passed without any positional', () => {
    expect(derivePassthroughSubcommand(undefined, ['--debug'])).toBeNull();
  });
});
