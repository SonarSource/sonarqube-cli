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

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  directorySizeBytes,
  formatByteSize,
} from '../../../../../src/cli/commands/system/dir-size';

describe('formatByteSize', () => {
  it('formats sub-kilobyte sizes in bytes', () => {
    expect(formatByteSize(0)).toBe('0B');
    expect(formatByteSize(1023)).toBe('1023B');
  });

  it('formats kilobyte sizes', () => {
    expect(formatByteSize(1024)).toBe('1KB');
    expect(formatByteSize(2048)).toBe('2KB');
  });

  it('formats megabyte sizes', () => {
    expect(formatByteSize(1024 * 1024)).toBe('1MB');
    expect(formatByteSize(3 * 1024 * 1024)).toBe('3MB');
  });
});

describe('directorySizeBytes', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('returns 0 for a missing directory', () => {
    expect(directorySizeBytes(join(tmpdir(), 'sonar-missing-dir-size'))).toBe(0);
  });

  it('sums nested files and subdirectories', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-dir-size-'));
    mkdirSync(join(tempDir, 'nested'), { recursive: true });
    writeFileSync(join(tempDir, 'root.txt'), 'x'.repeat(100));
    writeFileSync(join(tempDir, 'nested', 'leaf.txt'), 'y'.repeat(50));

    expect(directorySizeBytes(tempDir)).toBe(150);
  });

  it('ignores unreadable directories without throwing', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-dir-size-'));
    chmodSync(tempDir, 0o000);

    try {
      expect(directorySizeBytes(tempDir)).toBe(0);
    } finally {
      chmodSync(tempDir, 0o700);
    }
  });

  it('ignores entries that are neither files nor directories', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-dir-size-'));
    symlinkSync(join(tempDir, 'missing-target'), join(tempDir, 'broken-link'));

    expect(directorySizeBytes(tempDir)).toBe(0);
  });
});
