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

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { resolveSafePath } from '../../../../../src/cli/commands/system/safe-path';

describe('resolveSafePath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-safe-path-'));
  });

  afterEach(() => {
    // temp cleaned by OS
  });

  it('accepts paths under an allowed root', () => {
    const root = join(tempDir, 'bin');
    const file = join(root, 'sonar-secrets');
    mkdirSync(root, { recursive: true });
    writeFileSync(file, '');

    expect(resolveSafePath(file, [root])).toBe(file);
  });

  it('rejects paths outside allowed roots', () => {
    const root = join(tempDir, 'bin');
    const outside = join(tempDir, 'outside', 'file');
    mkdirSync(join(tempDir, 'outside'), { recursive: true });
    writeFileSync(outside, '');

    expect(resolveSafePath(outside, [root])).toBeUndefined();
  });

  it('rejects relative paths', () => {
    expect(resolveSafePath('relative/path', [tempDir])).toBeUndefined();
  });

  it('rejects symlink escapes', () => {
    const root = join(tempDir, 'bin');
    const outside = join(tempDir, 'outside');
    const link = join(root, 'escape');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret'), '');
    symlinkSync(outside, link);

    expect(resolveSafePath(join(link, 'secret'), [root])).toBeUndefined();
  });
});
