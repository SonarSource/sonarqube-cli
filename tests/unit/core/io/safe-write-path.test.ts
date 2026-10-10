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

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { assertSafeWritePath, writeRegularFile } from '@/core/io/safe-write-path.ts';

async function expectRefusedSymlinkWrite(write: Promise<void>): Promise<void> {
  try {
    await write;
    expect.unreachable('expected symlink refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(CommandFailedError);
  }
}

describe('assertSafeWritePath', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects writing through an existing symlink', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sonar-safe-write-'));
    const target = join(tempDir, 'target.txt');
    const link = join(tempDir, 'link.txt');
    await writeFile(target, 'secret');
    await symlink(target, link);

    await expectRefusedSymlinkWrite(assertSafeWritePath(link));
  });

  it('rejects writing when a parent directory is a symlink', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sonar-safe-write-'));
    const realDir = join(tempDir, 'real');
    const linkDir = join(tempDir, 'link');
    await mkdir(realDir);
    await symlink(realDir, linkDir);

    await expectRefusedSymlinkWrite(assertSafeWritePath(join(linkDir, 'nested', 'file.txt')));
  });

  it('rejects writing when a symlinked ancestor exists above an existing file', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sonar-safe-write-'));
    const realDir = join(tempDir, 'real');
    const linkDir = join(tempDir, 'link');
    await mkdir(realDir);
    await writeFile(join(realDir, 'settings.json'), '{}');
    await symlink(realDir, linkDir);

    await expectRefusedSymlinkWrite(assertSafeWritePath(join(linkDir, 'settings.json')));
  });

  it('writes a regular file when the path is safe', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sonar-safe-write-'));
    const filePath = join(tempDir, 'nested', 'file.txt');

    await writeRegularFile(filePath, 'hello');

    expect(await readFile(filePath, 'utf-8')).toBe('hello');
  });
});
