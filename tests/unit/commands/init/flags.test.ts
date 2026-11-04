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

import {
  validateProjectKey,
  validateProjectName,
  validateVisibility,
} from '@/commands/init/flags.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';

describe('validation', () => {
  it('accepts a SonarQube key and trims it', () => {
    expect(validateProjectKey(' my_org:proj-1.x ')).toBe('my_org:proj-1.x');
  });

  it.each(['', '   ', '123', 'has space', 'slash/key', 'a'.repeat(401)])(
    'rejects the key %p',
    (key) => {
      expect(() => validateProjectKey(key)).toThrow(InvalidOptionError);
    },
  );

  it('rejects an empty name or one with control characters', () => {
    expect(validateProjectName('  My project ')).toBe('My project');
    expect(() => validateProjectName('  ')).toThrow(InvalidOptionError);
    expect(() => validateProjectName('bad\nname')).toThrow(InvalidOptionError);
    expect(() => validateProjectName('bad\nname')).toThrow(/^--name must be/);
    expect(() => validateProjectName('bad\nname', 'Project name')).toThrow(/^Project name must be/);
  });

  it('accepts only private or public', () => {
    expect(validateVisibility('public')).toBe('public');
    expect(() => validateVisibility('internal')).toThrow(InvalidOptionError);
  });
});
