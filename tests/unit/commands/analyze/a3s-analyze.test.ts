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

import { buildA3sAnalyzeArgs } from '@/commands/analyze/a3s-analyze.ts';

describe('buildA3sAnalyzeArgs', () => {
  it.each([
    [{}, []],
    [{ format: 'text' as const }, []],
    [{ file: ['a.ts', 'b.ts'] }, ['--file', 'a.ts', '--file', 'b.ts']],
    [{ staged: true, force: true }, ['--staged', '--force']],
    [
      { base: 'main', branch: 'feat', project: 'proj', depth: 'DEEP', format: 'json' as const },
      [
        '--base',
        'main',
        '--branch',
        'feat',
        '--project',
        'proj',
        '--depth',
        'DEEP',
        '--format',
        'json',
      ],
    ],
  ])('forwards %j as %j', (options, expected) => {
    expect(buildA3sAnalyzeArgs(options)).toEqual(expected);
  });
});
