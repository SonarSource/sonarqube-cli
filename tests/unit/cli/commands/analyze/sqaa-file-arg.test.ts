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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { InvalidOptionError } from '../../../../../src/cli/commands/_common/error';
import {
  collectSqaaFileOption,
  resolveSqaaFileArgs,
} from '../../../../../src/cli/commands/analyze/sqaa-file-arg';

describe('sqaa-file-arg', () => {
  it('collectSqaaFileOption accumulates repeatable --file values', () => {
    expect(collectSqaaFileOption('a.ts', [])).toEqual(['a.ts']);
    expect(collectSqaaFileOption('b.ts', ['a.ts'])).toEqual(['a.ts', 'b.ts']);
  });

  it('resolveSqaaFileArgs resolves paths and rejects missing files and duplicates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqaa-file-arg-'));
    const existing = join(dir, 'exists.ts');
    writeFileSync(existing, 'x');

    expect(resolveSqaaFileArgs(['exists.ts'], dir)).toEqual([{ absolutePath: existing }]);

    expect(() => resolveSqaaFileArgs(['missing.ts'], dir)).toThrow(InvalidOptionError);
    expect(() => resolveSqaaFileArgs(['exists.ts', 'exists.ts'], dir)).toThrow(InvalidOptionError);
  });
});
