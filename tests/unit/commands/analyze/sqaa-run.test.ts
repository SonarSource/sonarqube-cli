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

import { prepareSqaaRequests } from '@/commands/analyze/sqaa-request.ts';
import { executeSqaaRun } from '@/commands/analyze/sqaa-run.ts';
import type { PreparedSqaaRun, SqaaProjectFiles } from '@/commands/analyze/sqaa-types.ts';
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

function run(projects: SqaaProjectFiles[]): PreparedSqaaRun {
  return {
    connection: CONNECTION,
    mode: 'change-set',
    displayDepth: 'STANDARD',
    displayBase: '/repo',
    ignored: [],
    files: {
      projects,
      displayPaths: projects.flatMap(({ files }) => files.map(({ displayPath }) => displayPath)),
      displayProjects: projects.map(({ projectKey, files }) => ({
        projectKey,
        paths: files.map(({ displayPath }) => displayPath),
      })),
    },
  };
}

const OPTIONS = { console: new FakeConsole(), format: 'json' as const };

describe('executeSqaaRun project groups', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let readSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(sqaaApi, 'fetchPreparedChunkWith413Split');
    readSpy = spyOn(sqaaApi, 'readSqaaFileContent').mockReturnValue('x');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    readSpy.mockRestore();
  });

  function succeedPerFile(): void {
    fetchSpy.mockImplementation((_connection: unknown, _request: unknown, files: unknown[]) =>
      Promise.resolve({
        parts: [{ response: { issues: [], errors: null }, files }],
        groupErrors: [],
      }),
    );
  }

  it('analyzes each project in order against its own project key and merges the results', async () => {
    succeedPerFile();
    const prepared = await prepareSqaaRequests(
      run([groupOf('app-a', 'x.ts'), groupOf('app-b', 'y.ts')]),
    );
    const { tally } = await executeSqaaRun(prepared, OPTIONS);

    expect(
      fetchSpy.mock.calls.map((call: unknown[]) => (call[1] as { projectKey: string }).projectKey),
    ).toEqual(['app-a', 'app-b']);
    expect(tally.allResults.map((r) => r.filePath)).toEqual(['app-a/x.ts', 'app-b/y.ts']);
  });

  it.each([1, 2])(
    'labels projects only when the run spans several projects (%i)',
    async (count) => {
      succeedPerFile();
      const prepared = await prepareSqaaRequests(
        run([groupOf('app-a', 'x.ts'), groupOf('app-b', 'y.ts')].slice(0, count)),
      );
      const chunks: string[] = [];
      const writeSpy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
      });
      const isTTY = process.stdout.isTTY;
      try {
        process.stdout.isTTY = true;
        await executeSqaaRun(prepared, { console: OPTIONS.console });
      } finally {
        process.stdout.isTTY = isTTY;
        writeSpy.mockRestore();
      }
      const output = chunks.join('');
      if (count === 1) {
        expect(output).not.toContain('Project 1/1');
      } else {
        expect(output).toContain('Project 1/2 · app-a');
        expect(output).toContain('Project 2/2 · app-b');
        expect(output.indexOf('Project 1/2')).toBeLessThan(output.indexOf('Project 2/2'));
      }
    },
  );

  it('stops at a global error instead of moving on to the next project', async () => {
    fetchSpy.mockRejectedValue(new SqaaForbiddenError());
    const prepared = await prepareSqaaRequests(
      run([groupOf('app-a', 'x.ts'), groupOf('app-b', 'y.ts')]),
    );
    const { tally } = await executeSqaaRun(prepared, OPTIONS);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(tally.globalError).toBeInstanceOf(SqaaForbiddenError);
  });
});
