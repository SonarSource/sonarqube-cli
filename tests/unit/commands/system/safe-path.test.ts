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

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { resolveSafePath } from '../../../../src/commands/system/safe-path.ts';

describe('resolveSafePath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'sonar-safe-path-')));
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

  it('accepts non-existent paths under an allowed root', () => {
    const root = join(tempDir, 'bin');
    mkdirSync(root, { recursive: true });
    const missing = join(root, 'stale-binary');

    expect(resolveSafePath(missing, [root])).toBe(missing);
  });

  it('accepts non-existent paths under a symlinked allowed root', () => {
    const realRoot = join(tempDir, 'real-bin');
    const linkRoot = join(tempDir, 'bin-link');
    mkdirSync(realRoot, { recursive: true });
    symlinkSync(realRoot, linkRoot);
    const missing = join(linkRoot, 'stale-binary');

    expect(resolveSafePath(missing, [linkRoot])).toBe(join(realRoot, 'stale-binary'));
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
