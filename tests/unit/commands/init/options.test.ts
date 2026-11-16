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
  parseMonorepoRoots,
  validateProjectKey,
  validateProjectName,
  validateVisibility,
} from '@/commands/init/options.ts';
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

describe('parseMonorepoRoots', () => {
  it('reads each path and key, normalizing the path', () => {
    expect(parseMonorepoRoots(['services/api=api-key', './web/=web-key', '.=root-key'])).toEqual([
      { path: 'services/api', projectKey: 'api-key' },
      { path: 'web', projectKey: 'web-key' },
      { path: '.', projectKey: 'root-key' },
    ]);
  });

  it('leaves the key out of a root named by its path alone', () => {
    expect(parseMonorepoRoots(['web', './docs/'])).toEqual([
      { path: 'web', projectKey: undefined },
      { path: 'docs', projectKey: undefined },
    ]);
  });

  it('reads a "=" followed by a path separator as part of the path', () => {
    expect(parseMonorepoRoots(['a=b/c'])).toEqual([{ path: 'a=b/c', projectKey: undefined }]);
  });

  it('is empty when no root was named', () => {
    expect(parseMonorepoRoots(undefined)).toEqual([]);
  });

  it('splits at the last "=", as only a path may contain one', () => {
    expect(parseMonorepoRoots(['a=b/c=key'])).toEqual([{ path: 'a=b/c', projectKey: 'key' }]);
  });

  it.each([
    '=key',
    '  =key',
    '/abs/path=key',
    '../outside=key',
    'a/../../outside=key',
    'bad\npath=key',
  ])('rejects the malformed root %p', (root) => {
    expect(() => parseMonorepoRoots([root])).toThrow(InvalidOptionError);
  });

  it('rejects an invalid project key, naming the option', () => {
    expect(() => parseMonorepoRoots(['api=bad key'])).toThrow(/^--root key must contain only/);
    expect(() => parseMonorepoRoots(['api='])).toThrow(/^--root key must contain only/);
  });

  it('rejects a directory or a key named twice', () => {
    expect(() => parseMonorepoRoots(['api=one', './api=two'])).toThrow(/"api" more than once/);
    expect(() => parseMonorepoRoots(['api=one', 'web=one'])).toThrow(/'one' more than once/);
    expect(() => parseMonorepoRoots(['api', './api'])).toThrow(/"api" more than once/);
  });
});
