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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CommandFailedError } from '@/core/command-error.ts';
import { RequestPayloadTooLargeError } from '@/core/server/errors.ts';
import { SqaaProgress } from '@/core/ui/components/sqaa-progress.ts';

import {
  distributeChunkResponse,
  runAnalyses,
  shouldContinueAfterChunk,
} from '../../../../src/commands/analyze/sqaa-analysis.ts';
import * as sqaaApi from '../../../../src/commands/analyze/sqaa-api.ts';
import type { SqaaAuth } from '../../../../src/commands/analyze/sqaa-auth.ts';
import type { SqaaChunkFile } from '../../../../src/commands/analyze/sqaa-chunking.ts';
import { payloadTooLargeCommandError } from '../../../../src/commands/analyze/sqaa-errors.ts';

describe('distributeChunkResponse', () => {
  it('attaches chunk-level errors only to the first file', () => {
    const chunkErrors = [{ code: 'WARN', message: 'chunk warning' }];
    const results = distributeChunkResponse([], chunkErrors, [
      { file: '/repo/a.ts', filePath: 'a.ts' },
      { file: '/repo/b.ts', filePath: 'b.ts' },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].errors).toEqual(chunkErrors);
    expect(results[1].errors).toBeNull();
  });

  it('attributes issues with unrecognized filePath to the first chunk file', () => {
    const results = distributeChunkResponse(
      [{ rule: 'ts:S1', message: 'issue', filePath: './a.ts', id: '1' }],
      null,
      [
        { file: '/repo/a.ts', filePath: 'a.ts' },
        { file: '/repo/b.ts', filePath: 'b.ts' },
      ],
    );

    expect(results[0].issues).toHaveLength(1);
    expect(results[1].issues).toHaveLength(0);
  });
});

describe('shouldContinueAfterChunk', () => {
  it('continues when some parts succeeded despite group errors', () => {
    expect(
      shouldContinueAfterChunk(
        [{ response: { issues: [], errors: null }, files: [] }],
        [{ files: [], error: new Error('fail') }],
      ),
    ).toBe(true);
  });

  it('continues when validation failures are recorded alongside successes', () => {
    expect(
      shouldContinueAfterChunk(
        [{ response: { issues: [], errors: null }, files: [] }],
        [{ files: [], error: new CommandFailedError('invalid path') }],
      ),
    ).toBe(true);
  });

  it('stops when the entire chunk failed via non-413 group errors only', () => {
    expect(shouldContinueAfterChunk([], [{ files: [], error: new Error('fail') }])).toBe(false);
  });

  it('continues when only 413 per-file failures were recorded in groupErrors', () => {
    expect(
      shouldContinueAfterChunk(
        [],
        [
          {
            files: [{ absolutePath: '/repo/a.ts', relativePath: 'a.ts', content: 'x' }],
            error: payloadTooLargeCommandError(
              new RequestPayloadTooLargeError('Request payload too large', 'REQUEST_TOO_LARGE'),
            ),
          },
        ],
      ),
    ).toBe(true);
  });

  it('stops when groupErrors mix 413 and non-413 failures', () => {
    expect(
      shouldContinueAfterChunk(
        [],
        [
          {
            files: [{ absolutePath: '/repo/a.ts', relativePath: 'a.ts', content: 'x' }],
            error: payloadTooLargeCommandError(
              new RequestPayloadTooLargeError('Request payload too large', 'REQUEST_TOO_LARGE'),
            ),
          },
          {
            files: [{ absolutePath: '/repo/b.ts', relativePath: 'b.ts', content: 'x' }],
            error: new Error('network down'),
          },
        ],
      ),
    ).toBe(false);
  });
});

describe('runAnalyses partial 413', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let readSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(sqaaApi, 'fetchChunkWith413Split');
    readSpy = spyOn(sqaaApi, 'readSqaaFileContent').mockReturnValue('x');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    readSpy.mockRestore();
  });

  function chunkFile(path: string): SqaaChunkFile {
    return { absolutePath: `/repo/${path}`, relativePath: path, content: 'x' };
  }

  const AUTH: SqaaAuth = { serverUrl: 'https://sonarcloud.io', token: 't', orgKey: 'org' };

  it('sends all readable files in one request and records partial 413 failures', async () => {
    const a = chunkFile('a.ts');
    const b = chunkFile('b.ts');
    const c = chunkFile('c.ts');

    fetchSpy.mockResolvedValue({
      parts: [
        {
          response: { issues: [{ rule: 'r', message: 'm', filePath: 'a.ts' }], errors: null },
          files: [a],
        },
        {
          response: { issues: [], errors: null },
          files: [c],
        },
      ],
      groupErrors: [
        {
          files: [b],
          error: payloadTooLargeCommandError(
            new RequestPayloadTooLargeError('Payload too large', 'REQUEST_TOO_LARGE'),
          ),
        },
      ],
    });

    const files = ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'];
    const progress = new SqaaProgress({ files: ['a.ts', 'b.ts', 'c.ts'], silent: true });
    const tally = await runAnalyses({
      files,
      allPaths: ['a.ts', 'b.ts', 'c.ts'],
      sqaaAuth: AUTH,
      projectKey: 'proj',
      branch: undefined,
      progress,
      analysisDepth: 'DEEP',
      displayAnalysisDepth: 'DEEP',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[2]).toEqual([a, b, c]);
    expect(tally.totalIssues).toBe(1);
    expect(tally.totalFailures).toBe(1);
    expect(tally.allResults).toHaveLength(3);
  });

  it('records read failures per file and continues analyzing readable files', async () => {
    const ok = chunkFile('ok.ts');
    readSpy.mockImplementation((file: string) => {
      if (file === '/repo/bad.ts') {
        throw new Error('Failed to read file');
      }
      return 'x';
    });
    fetchSpy.mockResolvedValue({
      parts: [{ response: { issues: [], errors: null }, files: [ok] }],
      groupErrors: [],
    });

    const progress = new SqaaProgress({ files: ['ok.ts', 'bad.ts'], silent: true });
    const tally = await runAnalyses({
      files: ['/repo/ok.ts', '/repo/bad.ts'],
      allPaths: ['ok.ts', 'bad.ts'],
      sqaaAuth: AUTH,
      projectKey: 'proj',
      branch: undefined,
      progress,
      analysisDepth: 'DEEP',
      displayAnalysisDepth: 'DEEP',
    });

    expect(tally.totalFailures).toBe(1);
    expect(tally.allResults).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
