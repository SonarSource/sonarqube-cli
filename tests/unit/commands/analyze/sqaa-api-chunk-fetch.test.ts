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

import { SqaaAnalysisClient } from '@/commands/analyze/sqaa-analysis-client.ts';
import type { SqaaAnalysisRequest } from '@/commands/analyze/sqaa-wire-types.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { ENV_SQAA_RETRY_BASE_DELAY_MS } from '@/core/config-constants.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { RequestPayloadTooLargeError, ServiceUnavailableError } from '@/core/server/errors.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { fetchPreparedChunkWith413Split } from '../../../../src/commands/analyze/sqaa-api.ts';
import type { SqaaChunkFile } from '../../../../src/commands/analyze/sqaa-chunking.ts';
import * as sqaaChunking from '../../../../src/commands/analyze/sqaa-chunking.ts';

const CONNECTION: SonarConnection = {
  auth: new ResolvedAuth({
    token: 'token',
    serverUrl: 'https://sonarcloud.io',
    orgKey: 'org',
    connectionType: 'cloud',
    source: 'state',
  }),
  httpClient: new SonarHttpClient('https://sonarcloud.io', 'token'),
};

function makeFile(relativePath: string): SqaaChunkFile {
  return {
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    content: 'const x = 1;',
  };
}

function request(files: SqaaChunkFile[]): SqaaAnalysisRequest {
  return {
    organizationKey: 'org',
    projectKey: 'project',
    files: files.map(({ relativePath, content }) => ({ path: relativePath, content })),
  };
}

describe('fetchPreparedChunkWith413Split', () => {
  let createAnalysisSpy: ReturnType<typeof spyOn>;
  let previousRetryDelay: string | undefined;

  beforeEach(() => {
    previousRetryDelay = process.env[ENV_SQAA_RETRY_BASE_DELAY_MS];
    process.env[ENV_SQAA_RETRY_BASE_DELAY_MS] = '0';
    createAnalysisSpy = spyOn(SqaaAnalysisClient.prototype, 'createAnalysis');
  });

  afterEach(() => {
    createAnalysisSpy.mockRestore();
    if (previousRetryDelay === undefined) {
      delete process.env[ENV_SQAA_RETRY_BASE_DELAY_MS];
    } else {
      process.env[ENV_SQAA_RETRY_BASE_DELAY_MS] = previousRetryDelay;
    }
  });

  it('returns partial successes when a later sub-chunk cannot be split further', async () => {
    createAnalysisSpy.mockImplementation((request: SqaaAnalysisRequest) => {
      if (request.files.length === 2) {
        return Promise.reject(
          new RequestPayloadTooLargeError('Payload too large', 'REQUEST_TOO_LARGE'),
        );
      }
      if (request.files[0]?.path === 'a.ts') {
        return Promise.resolve({
          issues: [{ rule: 'ts:S1', message: 'issue', filePath: 'a.ts' }],
          errors: null,
        });
      }
      return Promise.reject(
        new RequestPayloadTooLargeError('Payload too large', 'REQUEST_TOO_LARGE'),
      );
    });

    const result = await fetchPreparedChunkWith413Split(
      CONNECTION,
      request([makeFile('a.ts'), makeFile('b.ts')]),
      [makeFile('a.ts'), makeFile('b.ts')],
    );

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.response.issues).toHaveLength(1);
    expect(result.parts[0]?.response.issues[0]?.filePath).toBe('a.ts');
    expect(result.parts[0]?.files).toEqual([makeFile('a.ts')]);
    expect(result.groupErrors).toHaveLength(1);
    expect(result.groupErrors[0]?.files).toEqual([makeFile('b.ts')]);
  });

  it('keeps earlier sub-chunk successes when a later sub-chunk hits a non-413 error', async () => {
    createAnalysisSpy.mockImplementation((request: SqaaAnalysisRequest) => {
      if (request.files.length === 2) {
        return Promise.reject(
          new RequestPayloadTooLargeError('Payload too large', 'TOO_MANY_FILES'),
        );
      }
      if (request.files[0]?.path === 'a.ts') {
        return Promise.resolve({
          issues: [{ rule: 'ts:S1', message: 'issue', filePath: 'a.ts' }],
          errors: null,
        });
      }
      return Promise.reject(new CommandFailedError('network down'));
    });

    const result = await fetchPreparedChunkWith413Split(
      CONNECTION,
      request([makeFile('a.ts'), makeFile('b.ts')]),
      [makeFile('a.ts'), makeFile('b.ts')],
    );

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.response.issues).toHaveLength(1);
    expect(result.groupErrors).toHaveLength(1);
    expect(result.groupErrors[0]?.files).toEqual([makeFile('b.ts')]);
    expect(result.groupErrors[0]?.error.message).toContain('network down');
  });

  it('re-throws transient 503 errors from a later split sub-group', async () => {
    createAnalysisSpy.mockImplementation((request: SqaaAnalysisRequest) => {
      if (request.files.length === 2) {
        return Promise.reject(
          new RequestPayloadTooLargeError('Payload too large', 'TOO_MANY_FILES'),
        );
      }
      if (request.files[0]?.path === 'a.ts') {
        return Promise.resolve({ issues: [], errors: null });
      }
      return Promise.reject(new ServiceUnavailableError());
    });

    const err = await fetchPreparedChunkWith413Split(
      CONNECTION,
      request([makeFile('a.ts'), makeFile('b.ts')]),
      [makeFile('a.ts'), makeFile('b.ts')],
    ).catch((rejected: unknown) => rejected);

    expect(
      err instanceof ServiceUnavailableError ||
        (err instanceof CommandFailedError && err.cause instanceof ServiceUnavailableError),
    ).toBe(true);
  });

  it('uses server meta limits when re-packing after REQUEST_TOO_LARGE', async () => {
    const packSpy = spyOn(sqaaChunking, 'packFilesIntoChunks');

    createAnalysisSpy.mockImplementation((request: SqaaAnalysisRequest) => {
      if (request.files.length === 3) {
        return Promise.reject(
          new RequestPayloadTooLargeError('Payload too large', 'REQUEST_TOO_LARGE', {
            maxRequestSize: 512_000,
            maxFiles: 2,
          }),
        );
      }
      return Promise.resolve({ issues: [], errors: null });
    });

    const files = [makeFile('a.ts'), makeFile('b.ts'), makeFile('c.ts')];

    try {
      await fetchPreparedChunkWith413Split(CONNECTION, request(files), files);
      expect(packSpy.mock.calls[0]?.[1]).toMatchObject({
        maxRequestBytes: 512_000,
        maxFilesPerRequest: 2,
        organizationKey: 'org',
        projectKey: 'project',
      });
    } finally {
      packSpy.mockRestore();
    }
  });

  it('marks a single file as failed when it exceeds the payload limit', async () => {
    createAnalysisSpy.mockRejectedValue(
      new RequestPayloadTooLargeError('Request payload too large', 'REQUEST_TOO_LARGE', {
        maxRequestSize: 1024,
      }),
    );

    const file = makeFile('large.ts');
    const result = await fetchPreparedChunkWith413Split(CONNECTION, request([file]), [file]);

    expect(result.parts).toEqual([]);
    expect(result.groupErrors).toHaveLength(1);
    expect(result.groupErrors[0]?.files).toEqual([file]);
    expect(result.groupErrors[0]?.error.message).toContain('Request payload too large');
    expect((result.groupErrors[0]?.error as CommandFailedError).remediationHint).toContain('1 KB');
  });
});
