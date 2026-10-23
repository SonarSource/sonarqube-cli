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

import { runSqaaGroups } from '@/commands/analyze/sqaa-run.ts';
import type { SqaaProjectFiles } from '@/commands/analyze/sqaa-types.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { SqaaForbiddenError } from '@/core/server/errors.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import * as sqaaApi from '../../../../src/commands/analyze/sqaa-api.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';

const CONNECTION: SonarConnection = {
  auth: new ResolvedAuth({
    token: 't',
    serverUrl: 'https://sonarcloud.io',
    orgKey: 'org',
    connectionType: 'cloud',
    source: 'state',
  }),
  httpClient: new SonarHttpClient('https://sonarcloud.io', 't'),
};

function groupOf(projectKey: string, file: string): SqaaProjectFiles {
  return {
    projectKey,
    files: [
      {
        absolutePath: `/repo/${projectKey}/${file}`,
        displayPath: `${projectKey}/${file}`,
        serverPath: file,
      },
    ],
  };
}

const RUN = {
  branch: undefined,
  wireDepth: undefined,
  displayDepth: 'STANDARD' as const,
  console: new FakeConsole(),
};

describe('runSqaaGroups', () => {
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

  function succeedPerFile(): void {
    fetchSpy.mockImplementation((_connection: unknown, _key: unknown, files: unknown[]) =>
      Promise.resolve({
        parts: [{ response: { issues: [], errors: null }, files }],
        groupErrors: [],
      }),
    );
  }

  it('analyzes each project in order against its own project key and merges the results', async () => {
    succeedPerFile();

    const tally = await runSqaaGroups(
      [groupOf('app-a', 'x.ts'), groupOf('app-b', 'y.ts')],
      CONNECTION,
      { ...RUN, silent: true },
    );

    expect(fetchSpy.mock.calls.map((call: unknown[]) => call[1] as string)).toEqual([
      'app-a',
      'app-b',
    ]);
    expect(tally.allResults.map((r) => r.filePath)).toEqual(['app-a/x.ts', 'app-b/y.ts']);
  });

  it('labels each project, with its position out of the total, on the live progress', async () => {
    succeedPerFile();
    const chunks: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    const isTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      await runSqaaGroups([groupOf('app-a', 'x.ts'), groupOf('app-b', 'y.ts')], CONNECTION, {
        ...RUN,
        silent: false,
      });
    } finally {
      process.stdout.isTTY = isTTY;
      writeSpy.mockRestore();
    }

    const output = chunks.join('');
    expect(output).toContain('Project 1/2 · app-a');
    expect(output).toContain('Project 2/2 · app-b');
    expect(output.indexOf('Project 1/2')).toBeLessThan(output.indexOf('Project 2/2'));
  });

  it('does not label a run that covers one project', async () => {
    succeedPerFile();
    const chunks: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    const isTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      await runSqaaGroups([groupOf('app-a', 'x.ts')], CONNECTION, { ...RUN, silent: false });
    } finally {
      process.stdout.isTTY = isTTY;
      writeSpy.mockRestore();
    }

    expect(chunks.join('')).not.toContain('Project 1/1');
  });

  it('stops at a global error instead of moving on to the next project', async () => {
    fetchSpy.mockRejectedValue(new SqaaForbiddenError());

    const tally = await runSqaaGroups(
      [groupOf('app-a', 'x.ts'), groupOf('app-b', 'y.ts')],
      CONNECTION,
      { ...RUN, silent: true },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(tally.globalError).toBeInstanceOf(SqaaForbiddenError);
  });
});
