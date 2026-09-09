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

import { DuplicationsClient } from '@/core/server/duplications.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import type { DuplicationsShowResponse } from '@/core/server/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SERVER_URL = 'https://sonarqube.example.com';
const TOKEN = 'squ_test_token';

/** A file with a block duplicated elsewhere in the same file - one entry in `files`. */
const SELF_DUPLICATION_RESPONSE: DuplicationsShowResponse = {
  duplications: [
    {
      blocks: [
        { from: 207, size: 15, _ref: '1' },
        { from: 224, size: 15, _ref: '1' },
      ],
    },
  ],
  files: {
    '1': {
      key: 'my-project:src/core/gitlab/client.ts',
      name: 'src/core/gitlab/client.ts',
      uuid: 'AaBYbezoKkZLV8MxeIcw',
      project: 'my-project',
      projectUuid: 'AZwuC4xd-j8g-N-Vcf-Z',
      projectName: 'my-project',
    },
  },
};

/** A block duplicated between two distinct files - one entry per file in `files`. */
const CROSS_FILE_DUPLICATION_RESPONSE: DuplicationsShowResponse = {
  duplications: [
    {
      blocks: [
        { from: 1, size: 3820, _ref: '1' },
        { from: 1, size: 3820, _ref: '2' },
      ],
    },
  ],
  files: {
    '1': {
      key: 'my-project:ecosystem-map.html',
      name: 'ecosystem-map.html',
      uuid: 'AZ5LQbgSFcSfan2eOCYp',
      project: 'my-project',
      projectUuid: 'AZ5GTAApgb__dlBz5pu2',
      projectName: 'my-project',
    },
    '2': {
      key: 'my-project:index.html',
      name: 'index.html',
      uuid: 'AZ5LQbgSFcSfan2eOCYq',
      project: 'my-project',
      projectUuid: 'AZ5GTAApgb__dlBz5pu2',
      projectName: 'my-project',
    },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DuplicationsClient', () => {
  let client: DuplicationsClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new DuplicationsClient(new SonarHttpClient(SERVER_URL, TOKEN));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('requests /api/duplications/show with the component key', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(SELF_DUPLICATION_RESPONSE),
    );

    await client
      .getDuplicationInfo({ componentKey: 'my-project:src/core/gitlab/client.ts' })
      .orThrow();

    const url = (fetchSpy.mock.calls[0][0] as URL).toString();
    expect(url).toContain('/api/duplications/show');
    expect(url).toContain('key=my-project%3Asrc%2Fcore%2Fgitlab%2Fclient.ts');
  });

  it("counts each of the file's own occurrences, not the number of duplication groups", async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(SELF_DUPLICATION_RESPONSE),
    );

    const result = await client
      .getDuplicationInfo({
        componentKey: 'my-project:src/core/gitlab/client.ts',
      })
      .orThrow();

    // One duplication group, but both of its blocks belong to the queried file itself.
    expect(result.blockCount).toBe(2);
  });

  it('reports no peers when every block in every group belongs to the queried file itself', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(SELF_DUPLICATION_RESPONSE),
    );

    const result = await client
      .getDuplicationInfo({
        componentKey: 'my-project:src/core/gitlab/client.ts',
      })
      .orThrow();

    expect(result.duplicatesWith).toEqual([]);
  });

  it('resolves peer file paths from the sibling files map, excluding the queried file itself', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(CROSS_FILE_DUPLICATION_RESPONSE),
    );

    const result = await client
      .getDuplicationInfo({
        componentKey: 'my-project:ecosystem-map.html',
      })
      .orThrow();

    expect(result.blockCount).toBe(1);
    expect(result.duplicatesWith).toEqual(['index.html']);
  });

  it('resolves peers correctly regardless of which side of the pair is queried', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(CROSS_FILE_DUPLICATION_RESPONSE),
    );

    const result = await client
      .getDuplicationInfo({ componentKey: 'my-project:index.html' })
      .orThrow();

    expect(result.duplicatesWith).toEqual(['ecosystem-map.html']);
  });

  it('deduplicates a peer that recurs across multiple duplication groups', async () => {
    const response: DuplicationsShowResponse = {
      duplications: [
        {
          blocks: [
            { from: 1, size: 10, _ref: '1' },
            { from: 1, size: 10, _ref: '2' },
          ],
        },
        {
          blocks: [
            { from: 20, size: 5, _ref: '1' },
            { from: 20, size: 5, _ref: '2' },
          ],
        },
      ],
      files: CROSS_FILE_DUPLICATION_RESPONSE.files,
    };
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(response));

    const result = await client
      .getDuplicationInfo({
        componentKey: 'my-project:ecosystem-map.html',
      })
      .orThrow();

    expect(result.blockCount).toBe(2);
    expect(result.duplicatesWith).toEqual(['index.html']);
  });

  it('drops only the unresolvable peer instead of throwing when a ref has no entry in files', async () => {
    const response: DuplicationsShowResponse = {
      duplications: [
        {
          blocks: [
            { from: 1, size: 10, _ref: '1' },
            // '2' is not in `files` - a peer that isn't browsable, or since removed.
            { from: 1, size: 10, _ref: '2' },
          ],
        },
      ],
      files: { '1': CROSS_FILE_DUPLICATION_RESPONSE.files['1'] },
    };
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(response));

    const result = await client
      .getDuplicationInfo({
        componentKey: 'my-project:ecosystem-map.html',
      })
      .orThrow();

    expect(result.blockCount).toBe(1);
    expect(result.duplicatesWith).toEqual([]);
  });

  it('skips a block with no ref at all instead of throwing', async () => {
    const response: DuplicationsShowResponse = {
      duplications: [
        {
          blocks: [
            { from: 1, size: 10, _ref: '1' },
            { from: 1, size: 10 },
          ],
        },
      ],
      files: { '1': CROSS_FILE_DUPLICATION_RESPONSE.files['1'] },
    };
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(response));

    const result = await client
      .getDuplicationInfo({
        componentKey: 'my-project:ecosystem-map.html',
      })
      .orThrow();

    expect(result.duplicatesWith).toEqual([]);
  });

  it('reports zero blocks and no peers when the file has no duplications at all', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ duplications: [], files: {} }),
    );

    const result = await client
      .getDuplicationInfo({ componentKey: 'my-project:src/clean.ts' })
      .orThrow();

    expect(result).toEqual({ blockCount: 0, duplicatesWith: [] });
  });

  it('omits branch and pull request from the query when not given', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(SELF_DUPLICATION_RESPONSE),
    );

    await client
      .getDuplicationInfo({ componentKey: 'my-project:src/core/gitlab/client.ts' })
      .orThrow();

    const url = (fetchSpy.mock.calls[0][0] as URL).toString();
    expect(url).not.toContain('branch=');
    expect(url).not.toContain('pullRequest=');
  });

  it('forwards branch and pull request when given - a file scoped to a branch or PR 404s otherwise', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(SELF_DUPLICATION_RESPONSE),
    );

    await client
      .getDuplicationInfo({
        componentKey: 'my-project:src/core/gitlab/client.ts',
        branch: 'feature-x',
      })
      .orThrow();
    expect((fetchSpy.mock.calls[0][0] as URL).toString()).toContain('branch=feature-x');

    await client
      .getDuplicationInfo({
        componentKey: 'my-project:src/core/gitlab/client.ts',
        pullRequest: '42',
      })
      .orThrow();
    expect((fetchSpy.mock.calls[1][0] as URL).toString()).toContain('pullRequest=42');
  });
});
