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

import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'bun:test';

import {
  extractFileFromTar,
  extractFileFromTarGz,
  TAR_BLOCK_SIZE,
} from '../../../src/cli/commands/_common/install/tar';

const NAME_LEN = 100;
const MODE_OFFSET = 100;
const SIZE_OFFSET = 124;
const TYPEFLAG_OFFSET = 156;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_LEN = 8;
const SIZE_OCTAL_LEN = 11; // 12 bytes total: 11 octal digits + NUL
const CHECKSUM_OCTAL_LEN = 6; // 8 bytes total: 6 octal digits + NUL + space
const ASCII_SPACE = 0x20;
const TWO_DATA_BLOCK_SIZE = 700; // > 512 to force multi-block alignment
const FILL_BYTE = 0xab;

/**
 * Build a minimal valid USTAR file entry: 1 header block + N data blocks.
 * Returns the concatenated buffer (header + data, padded to 512-byte multiples).
 */
function buildTarEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(name, 0, Math.min(name.length, NAME_LEN), 'utf-8');
  header.write('0000644\0', MODE_OFFSET, 'utf-8'); // file mode
  const sizeOctal = content.length.toString(8).padStart(SIZE_OCTAL_LEN, '0') + '\0';
  header.write(sizeOctal, SIZE_OFFSET, 'utf-8');
  header.write('0', TYPEFLAG_OFFSET, 'utf-8'); // regular file
  // Fill checksum field with spaces, then compute and write the checksum.
  for (let i = 0; i < CHECKSUM_LEN; i++) header[CHECKSUM_OFFSET + i] = ASCII_SPACE;
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumStr = checksum.toString(8).padStart(CHECKSUM_OCTAL_LEN, '0') + '\0 ';
  header.write(checksumStr, CHECKSUM_OFFSET, 'utf-8');

  const padded = Math.ceil(content.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  const data = Buffer.alloc(padded);
  content.copy(data, 0);
  return Buffer.concat([header, data]);
}

function buildTarArchive(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const blocks = entries.map((e) => buildTarEntry(e.name, e.content));
  const eof = Buffer.alloc(TAR_BLOCK_SIZE * 2); // two empty blocks per spec
  return Buffer.concat([...blocks, eof]);
}

describe('tar.extractFileFromTar', () => {
  it('returns the bytes of a regular-file entry matched by basename', () => {
    const tar = buildTarArchive([
      { name: 'LICENSE', content: Buffer.from('MIT', 'utf-8') },
      { name: 'sonar-context-augmentation', content: Buffer.from('binary-bytes', 'utf-8') },
      { name: 'LICENSE_THIRD_PARTY.txt', content: Buffer.from('third-party', 'utf-8') },
    ]);
    const bytes = extractFileFromTar(tar, 'sonar-context-augmentation');
    expect(bytes).not.toBeNull();
    expect(bytes!.toString('utf-8')).toBe('binary-bytes');
  });

  it('handles entries inside a top-level directory by matching the basename', () => {
    const tar = buildTarArchive([
      {
        name: 'sonar-context-augmentation-macos-arm64/sonar-context-augmentation',
        content: Buffer.from('inner-binary', 'utf-8'),
      },
    ]);
    const bytes = extractFileFromTar(tar, 'sonar-context-augmentation');
    expect(bytes).not.toBeNull();
    expect(bytes!.toString('utf-8')).toBe('inner-binary');
  });

  it('returns null when no entry matches', () => {
    const tar = buildTarArchive([{ name: 'README.md', content: Buffer.from('hello', 'utf-8') }]);
    expect(extractFileFromTar(tar, 'sonar-context-augmentation')).toBeNull();
  });

  it('respects 512-byte block alignment for entries whose size is not a multiple of 512', () => {
    const first = Buffer.alloc(TWO_DATA_BLOCK_SIZE, FILL_BYTE); // forces multi-block alignment
    const second = Buffer.from('target-bytes', 'utf-8');
    const tar = buildTarArchive([
      { name: 'a.bin', content: first },
      { name: 'target', content: second },
    ]);
    const bytes = extractFileFromTar(tar, 'target');
    expect(bytes).not.toBeNull();
    expect(bytes!.toString('utf-8')).toBe('target-bytes');
  });
});

describe('tar.extractFileFromTarGz', () => {
  it('gunzips and extracts in one call', () => {
    const tar = buildTarArchive([
      { name: 'sonar-context-augmentation.exe', content: Buffer.from('windows-binary', 'utf-8') },
    ]);
    const gz = gzipSync(tar);
    const bytes = extractFileFromTarGz(gz, 'sonar-context-augmentation.exe');
    expect(bytes).not.toBeNull();
    expect(bytes!.toString('utf-8')).toBe('windows-binary');
  });
});
