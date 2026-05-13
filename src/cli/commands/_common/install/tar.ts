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

// Minimal in-process tar reader. Sufficient for SonarSource binary archives
// where we only need to extract a single regular-file entry by basename.
// Implements the USTAR header layout (POSIX 1003.1-1988): 512-byte aligned
// blocks, octal-ASCII size at offset 124, typeflag at 156.
//
// Limitations: GNU tar long-name extensions (typeflag 'L' / 'K') are NOT
// supported — the long-name payload would be misparsed as a header block and
// the following real entry would be skipped. Any SonarSource archive with
// paths exceeding 100 bytes must be repacked in USTAR-compatible form.

import { gunzipSync } from 'node:zlib';

export const TAR_BLOCK_SIZE = 512;
const TAR_NAME_LEN = 100;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LEN = 12;
const TAR_TYPEFLAG_OFFSET = 156;
const OCTAL_RADIX = 8;

/**
 * Extract a single regular-file entry from a gzipped tar archive by basename.
 * Returns null when no matching entry is found. Other entries are ignored.
 */
export function extractFileFromTarGz(gzipped: Buffer, entryBasename: string): Buffer | null {
  const tar = gunzipSync(gzipped);
  return extractFileFromTar(tar, entryBasename);
}

/**
 * Extract a single regular-file entry from an uncompressed tar archive by
 * basename. Exposed for testing.
 */
export function extractFileFromTar(tar: Buffer, entryBasename: string): Buffer | null {
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((b) => b === 0)) {
      break;
    }
    const name = readNullTerminated(header, 0, TAR_NAME_LEN);
    const sizeStr = readNullTerminated(header, TAR_SIZE_OFFSET, TAR_SIZE_LEN).trim();
    const size = sizeStr ? Number.parseInt(sizeStr, OCTAL_RADIX) : 0;
    const typeflag = String.fromCodePoint(header[TAR_TYPEFLAG_OFFSET]);
    const isRegularFile = typeflag === '0' || typeflag === '\0';

    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;

    if (isRegularFile && name && basename(name) === entryBasename) {
      return Buffer.from(tar.subarray(dataStart, dataEnd));
    }

    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return null;
}

function readNullTerminated(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString('utf-8');
}

function basename(p: string): string {
  // tar entry names use forward slashes regardless of platform.
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}
