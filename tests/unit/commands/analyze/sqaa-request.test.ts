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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { SqaaAnalysisClient } from '@/commands/analyze/sqaa-analysis-client.ts';
import { resolveSqaaRunFiles } from '@/commands/analyze/sqaa-paths.ts';
import { prepareSqaaProject, prepareSqaaRequests } from '@/commands/analyze/sqaa-request.ts';
import { executeSqaaRun } from '@/commands/analyze/sqaa-run.ts';
import type { PreparedSqaaRun } from '@/commands/analyze/sqaa-types.ts';
import type { SqaaAnalysisRequest } from '@/commands/analyze/sqaa-wire-types.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { ENV_SQAA_RETRY_BASE_DELAY_MS } from '@/core/config-constants.ts';
import { RequestPayloadTooLargeError, ServiceUnavailableError } from '@/core/server/errors.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

function connection(serverUrl = 'https://sonarcloud.io', orgKey: string | undefined = 'org') {
  return {
    auth: new ResolvedAuth({
      token: 't',
      serverUrl,
      orgKey,
      connectionType: orgKey ? 'cloud' : 'on-premise',
      source: 'state',
    }),
    httpClient: new SonarHttpClient(serverUrl, 't'),
  };
}

const OPTIONS = { console: new FakeConsole(), format: 'json' as const };

describe('prepared SQAA requests', () => {
  let root: string;
  let createAnalysis: ReturnType<typeof spyOn<SqaaAnalysisClient, 'createAnalysis'>>;
  let previousDelay: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sqaa-prepared-'));
    createAnalysis = spyOn(SqaaAnalysisClient.prototype, 'createAnalysis').mockResolvedValue({
      id: 'analysis',
      issues: [],
    });
    previousDelay = process.env[ENV_SQAA_RETRY_BASE_DELAY_MS];
    process.env[ENV_SQAA_RETRY_BASE_DELAY_MS] = '0';
  });

  afterEach(() => {
    createAnalysis.mockRestore();
    rmSync(root, { recursive: true, force: true });
    if (previousDelay === undefined) delete process.env[ENV_SQAA_RETRY_BASE_DELAY_MS];
    else process.env[ENV_SQAA_RETRY_BASE_DELAY_MS] = previousDelay;
  });

  function run(mode: PreparedSqaaRun['mode'] = 'change-set', count = 2): PreparedSqaaRun {
    const files = Array.from({ length: count }, (_, i) => {
      const path = join(root, `${i}.ts`);
      writeFileSync(path, `const value = ${i};`);
      return path;
    });
    return {
      connection: connection(),
      mode,
      branch: 'feature',
      wireDepth: 'DEEP',
      displayDepth: 'DEEP',
      displayBase: root,
      ignored: [],
      files: resolveSqaaRunFiles([{ projectKey: 'project', projectRoot: root, files }], root),
    };
  }

  it.each(['single-file', 'multi-file', 'change-set', 'edited-file'] as const)(
    'executes the prepared %s payload after source files change or disappear',
    async (mode) => {
      const context = run(mode, mode === 'single-file' || mode === 'edited-file' ? 1 : 2);
      const prepared = await prepareSqaaRequests(context);
      const payload = structuredClone(prepared.projects[0].payload);
      expect(createAnalysis).not.toHaveBeenCalled();
      expect(prepared.projects[0].serverUrl).toBe('https://sonarcloud.io');
      expect(payload).toEqual({
        organizationKey: 'org',
        projectKey: 'project',
        analysisDepth: 'DEEP',
        ...(mode === 'edited-file' ? {} : { branchName: 'feature' }),
        files: context.files.projects[0].files.map((path, i) => ({
          path: path.serverPath,
          content: `const value = ${i};`,
        })),
      });
      for (const path of context.files.projects[0].files) rmSync(path.absolutePath);
      const { tally } = await executeSqaaRun(prepared, OPTIONS);
      expect(tally.totalFailures).toBe(0);
      expect(tally.allResults).toHaveLength(payload.files.length);
      expect(createAnalysis.mock.calls.map(([request]) => request)).toEqual([payload]);
    },
  );

  it('keeps STANDARD depth omitted and resolves all project payloads before execution', async () => {
    const context = run();
    context.wireDepth = undefined;
    context.displayDepth = 'STANDARD';
    const [a, b] = context.files.projects[0].files;
    context.files.projects = [
      { projectKey: 'a', files: [a] },
      { projectKey: 'b', files: [b] },
    ];
    const prepared = await prepareSqaaRequests(context);
    createAnalysis.mockImplementation(() => {
      writeFileSync(b.absolutePath, 'changed during first project');
      return Promise.resolve({ id: 'analysis', issues: [] });
    });
    await executeSqaaRun(prepared, OPTIONS);
    expect(createAnalysis.mock.calls.map(([request]) => request)).toEqual(
      prepared.projects.map(({ payload }) => payload),
    );
    expect(createAnalysis.mock.calls[1][0].files[0].content).toBe('const value = 1;');
    expect(createAnalysis.mock.calls[0][0]).not.toHaveProperty('analysisDepth');
  });

  it('retries and splits the prepared payload without rereading files or changing its envelope', async () => {
    const context = run();
    const prepared = await prepareSqaaRequests(context);
    const payload = structuredClone(prepared.projects[0].payload);
    const requests: SqaaAnalysisRequest[] = [];
    createAnalysis.mockImplementation((request) => {
      requests.push(structuredClone(request));
      for (const path of context.files.projects[0].files)
        writeFileSync(path.absolutePath, 'changed');
      if (requests.length === 1) throw new ServiceUnavailableError();
      if (request.files.length > 1)
        throw new RequestPayloadTooLargeError('too large', 'REQUEST_TOO_LARGE');
      return Promise.resolve({ id: 'analysis', issues: [] });
    });
    const { tally } = await executeSqaaRun(prepared, OPTIONS);
    expect(tally.totalFailures).toBe(0);
    expect(requests).toEqual([
      payload,
      payload,
      ...payload.files.map((file) => ({ ...payload, files: [file] })),
    ]);
    expect(prepared.projects[0].payload).toEqual(payload);
  });

  it('keeps unreadable files and validation failures out of the payload and reports them on every execution', async () => {
    const context = run();
    const [missing, invalid] = context.files.projects[0].files;
    rmSync(missing.absolutePath);
    invalid.serverPath = '../invalid.ts';
    const prepared = await prepareSqaaRequests(context);
    expect(prepared.projects[0].payload.files).toEqual([]);
    for (let i = 0; i < 2; i++) {
      const { tally } = await executeSqaaRun(prepared, OPTIONS);
      expect(tally.totalFailures).toBe(2);
      expect(tally.allResults.map(({ file }) => file)).toEqual([
        missing.absolutePath,
        invalid.absolutePath,
      ]);
    }
    expect(createAnalysis).not.toHaveBeenCalled();
  });

  it('preserves partial validation failures while sending valid files', async () => {
    const context = run();
    context.files.projects[0].files[1].serverPath = '../invalid.ts';
    const prepared = await prepareSqaaRequests(context);
    const { tally } = await executeSqaaRun(prepared, OPTIONS);
    expect(tally.totalFailures).toBe(1);
    expect(tally.allResults).toHaveLength(2);
    expect(createAnalysis.mock.calls[0][0].files).toEqual([
      { path: '0.ts', content: 'const value = 0;' },
    ]);
  });

  it('exposes the destination independently of credentials and supports an empty run', async () => {
    const context = run();
    const project = context.files.projects[0];
    const us = prepareSqaaProject(project, connection('https://sonarqube.us/'));
    const server = prepareSqaaProject(
      project,
      connection('https://sonar.example.test/context', ''),
    );
    expect(us.serverUrl).toBe('https://sonarqube.us');
    expect(server.serverUrl).toBe('https://sonar.example.test/context');
    expect(server.payload).not.toHaveProperty('organizationKey');
    expect(JSON.stringify(us)).not.toContain('token');
    context.files = resolveSqaaRunFiles([], root);
    const prepared = await prepareSqaaRequests(context);
    expect(prepared.projects).toEqual([]);
    expect((await executeSqaaRun(prepared, OPTIONS)).tally.allResults).toEqual([]);
    expect(createAnalysis).not.toHaveBeenCalled();
  });
});
