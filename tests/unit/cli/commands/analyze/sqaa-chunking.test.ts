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

import {
  estimateRequestBytes,
  packFilesIntoChunks,
  type SqaaChunkFile,
} from '../../../../../src/cli/commands/analyze/sqaa-chunking';

function makeFile(relativePath: string, content: string): SqaaChunkFile {
  return { absolutePath: `/repo/${relativePath}`, relativePath, content };
}

describe('packFilesIntoChunks', () => {
  it('returns no chunks for an empty list', () => {
    expect(packFilesIntoChunks([])).toEqual([]);
  });

  it('returns one chunk for all files when no limits are provided', () => {
    const files = Array.from({ length: 50 }, (_, i) =>
      makeFile(`file${i}.ts`, `const x${i} = ${i};`),
    );
    const chunks = packFilesIntoChunks(files);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].files).toHaveLength(50);
  });

  it('packs a single small file into one chunk', () => {
    const chunks = packFilesIntoChunks([makeFile('a.ts', 'const x = 1;')]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].files).toHaveLength(1);
  });

  it('splits when file count exceeds maxFilesPerRequest', () => {
    const files = Array.from({ length: 5 }, (_, i) =>
      makeFile(`file${i}.ts`, `const x${i} = ${i};`),
    );
    const chunks = packFilesIntoChunks(files, { maxFilesPerRequest: 2 });
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.files.length)).toEqual([2, 2, 1]);
  });

  it('splits when payload exceeds the byte budget', () => {
    const largeContent = 'x'.repeat(4 * 1024 * 1024);
    const maxRequestBytes = 10 * 1024 * 1024;
    const files = [
      makeFile('a.ts', largeContent),
      makeFile('b.ts', largeContent),
      makeFile('c.ts', largeContent),
    ];
    const chunks = packFilesIntoChunks(files, { maxRequestBytes });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const bytes = estimateRequestBytes({
        organizationKey: 'org',
        projectKey: 'proj',
        files: chunk.files.map((f) => ({ path: f.relativePath, content: f.content })),
      });
      expect(bytes).toBeLessThanOrEqual(maxRequestBytes);
    }
  });

  it('accounts for JSON wrapper overhead in byte estimates', () => {
    const content = 'a'.repeat(100);
    const file = makeFile('src/big.ts', content);
    const withWrapper = estimateRequestBytes({
      organizationKey: 'my-org',
      projectKey: 'my-project',
      branchName: 'feature/x',
      files: [{ path: file.relativePath, content: file.content }],
    });
    expect(withWrapper).toBeGreaterThan(Buffer.byteLength(content, 'utf8'));
  });

  it('matches full JSON.stringify byte estimates for each packed chunk', () => {
    const maxRequestBytes = 10 * 1024 * 1024;
    const files = Array.from({ length: 30 }, (_, i) =>
      makeFile(`src/file-${i}.ts`, `export const v${i} = ${i};\n`.repeat(20)),
    );
    const chunks = packFilesIntoChunks(files, { maxRequestBytes });
    for (const chunk of chunks) {
      const incrementalBytes = estimateRequestBytes({
        organizationKey: '',
        projectKey: '',
        files: chunk.files.map((f) => ({ path: f.relativePath, content: f.content })),
      });
      expect(incrementalBytes).toBeLessThanOrEqual(maxRequestBytes);
    }
  });
});
