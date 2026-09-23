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

// Reads blob contents out of git and encodes them as the analyzer's batched-stdin contract.
// Git's own framing never reaches the analyzer: this module is the boundary between the two.

import { spawnProcessCapturingBytes } from '@/core/process/process.ts';

/** A blob git holds, named by the path it occupies in the commit that introduced it. */
export interface GitBlobRef {
  oid: string;
  path: string;
}

export interface BlobContent {
  blob: GitBlobRef;
  content: Buffer;
}

const LINE_FEED = 0x0a;

/**
 * Reads every blob's exact bytes. Returns `null` when git failed or answered with anything other than one blob per
 * request, so a caller can refuse to report a clean scan of content it never read.
 */
export async function readBlobContents(
  blobs: GitBlobRef[],
  cwd: string,
): Promise<BlobContent[] | null> {
  if (blobs.length === 0) return [];
  const result = await spawnProcessCapturingBytes('git', ['cat-file', '--batch'], {
    cwd,
    stdin: 'pipe',
    stdinData: blobs.map((blob) => blob.oid).join('\n') + '\n',
  });
  if (result.exitCode !== 0) return null;

  const contents = parseBatchOutput(result.stdout);
  // A short or unparseable answer means we did not read what we asked for, so refuse rather than under-report.
  if (contents?.length !== blobs.length) return null;
  return blobs.map((blob, index) => ({ blob, content: contents[index] }));
}

/**
 * Encodes the contract the analyzer reads on stdin: `<byteCount> <path>` and a newline, then exactly that many bytes
 * and a newline, per file. The count precedes the content so a path needs no quoting and the bytes need no escaping.
 */
export function encodeBatch(contents: BlobContent[]): Buffer {
  const parts: Buffer[] = [];
  for (const { blob, content } of contents) {
    parts.push(
      Buffer.from(`${content.length} ${blob.path}\n`, 'utf-8'),
      content,
      Buffer.from('\n'),
    );
  }
  return Buffer.concat(parts);
}

/** A path holding a newline would break the header line, so it cannot be sent as-is. */
export function isEncodablePath(path: string): boolean {
  return !path.includes('\n') && !path.includes('\r');
}

/** Parses `git cat-file --batch` output: `<oid> <type> <size>` and a newline, the bytes, then a newline. */
function parseBatchOutput(stdout: Buffer): Buffer[] | null {
  const contents: Buffer[] = [];
  let offset = 0;
  while (offset < stdout.length) {
    const headerEnd = stdout.indexOf(LINE_FEED, offset);
    if (headerEnd < 0) return null;
    // A requested object git does not have prints `<oid> missing`, which has no size and no content.
    const size = Number(stdout.toString('ascii', offset, headerEnd).split(' ')[2]);
    if (!Number.isInteger(size) || size < 0) return null;
    const start = headerEnd + 1;
    const end = start + size;
    if (end > stdout.length) return null;
    contents.push(stdout.subarray(start, end));
    offset = end + 1;
  }
  return contents;
}
