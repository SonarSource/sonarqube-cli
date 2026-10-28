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
const RECORD_TERMINATOR = Buffer.from('\n');

/**
 * Reads every blob's exact bytes. `null` when git failed or answered with anything other than one blob per request,
 * so a caller can refuse to report a clean scan of content it never read.
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
  if (contents?.length !== blobs.length) return null;
  return blobs.map((blob, index) => ({ blob, content: contents[index] }));
}

/** Asks git for sizes without content. `null` when git failed, so a caller can send everything unfiltered. */
export async function readBlobSizes(
  blobs: GitBlobRef[],
  cwd: string,
): Promise<Map<string, number> | null> {
  if (blobs.length === 0) return new Map();
  const result = await spawnProcessCapturingBytes('git', ['cat-file', '--batch-check'], {
    cwd,
    stdin: 'pipe',
    stdinData: blobs.map((blob) => blob.oid).join('\n') + '\n',
  });
  if (result.exitCode !== 0) return null;

  const sizes = new Map<string, number>();
  for (const line of result.stdout.toString('utf-8').split('\n')) {
    // git prints `<oid> missing` for an object it does not have, with no size to record.
    const [oid, , size] = line.split(' ');
    const byteCount = Number(size);
    if (oid && Number.isInteger(byteCount) && byteCount >= 0) sizes.set(oid, byteCount);
  }
  return sizes;
}

/**
 * Encodes one scan: a `scan <id>` line, then `<byteCount> <path>` and a newline, that many bytes, and a newline per
 * file. The count precedes the content so a path needs no quoting and the bytes need no escaping.
 */
export function scanChunks(scanId: string, contents: BlobContent[]): Buffer[] {
  const chunks: Buffer[] = [Buffer.from(`scan ${scanId}\n`, 'utf-8')];
  for (const { blob, content } of contents) {
    chunks.push(
      Buffer.from(`${content.length} ${blob.path}\n`, 'utf-8'),
      content,
      RECORD_TERMINATOR,
    );
  }
  return chunks;
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
    // git prints `<oid> missing` for an object it does not have, with no size and no content.
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
