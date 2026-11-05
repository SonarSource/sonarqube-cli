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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { git, initGitRepo, stageFile } from '../hook/git-test-helpers';
import { parseSqaaRequestBody } from './sqaa-request-helpers';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const TEST_PROJECT = 'my-project';

describe('agentic analysis before the first commit', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function configureAnalysis(format = 'sha1') {
    mkdirSync(harness.cwd.path, { recursive: true });
    git(['init', `--object-format=${format}`], harness.cwd.path);
    initGitRepo(harness.cwd.path);
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withSqaaResponse({ issues: [] })
      .start();
    harness
      .state()
      .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
      .withSqaaFeature(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());
    return server;
  }

  it.each(['sha1', 'sha256'])(
    'submits staged and untracked working-tree source with %s',
    async (format) => {
      const server = await configureAnalysis(format);
      harness.cwd.writeFile('.gitignore', '*.ignored.ts\n');
      stageFile(harness.cwd.path, 'staged.ts', 'const staged = 1;');
      harness.cwd.writeFile('staged.ts', 'const staged = 2;');
      harness.cwd.writeFile('untracked.ts', 'const untracked = 1;');
      harness.cwd.writeFile('excluded.ignored.ts', 'const ignored = 1;');
      writeFileSync(join(harness.cwd.path, 'binary.ts'), Buffer.from([0, 1]));

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(0);
      const calls = server
        .getRecordedRequests()
        .filter((request) => request.path.endsWith('/analyses'));
      expect(calls).toHaveLength(1);
      const body = parseSqaaRequestBody(calls[0].body);
      expect(body.analysisDepth).toBe('DEEP');
      expect(body.files?.find((file) => file.path === 'staged.ts')?.content).toBe(
        'const staged = 2;',
      );
      expect(body.files?.find((file) => file.path === 'untracked.ts')?.content).toBe(
        'const untracked = 1;',
      );
      expect(body.files?.filter((file) => file.path.endsWith('.ts'))).toHaveLength(2);
    },
    { timeout: 15000 },
  );

  it(
    'keeps staged-only analysis limited to staged files',
    async () => {
      const server = await configureAnalysis();
      stageFile(harness.cwd.path, 'staged.ts', 'const staged = 1;');
      harness.cwd.writeFile('untracked.ts', 'const untracked = 1;');

      const result = await harness.run('analyze agentic --staged');

      expect(result.exitCode).toBe(0);
      const calls = server
        .getRecordedRequests()
        .filter((request) => request.path.endsWith('/analyses'));
      expect(calls).toHaveLength(1);
      expect(parseSqaaRequestBody(calls[0].body).files).toEqual([
        expect.objectContaining({ path: 'staged.ts' }),
      ]);
    },
    { timeout: 15000 },
  );

  it(
    'reports an empty change set without submitting analysis',
    async () => {
      const server = await configureAnalysis();

      const result = await harness.run('analyze agentic');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('no files in the change set');
      expect(
        server.getRecordedRequests().filter((request) => request.path.endsWith('/analyses')),
      ).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'preserves errors for an explicit missing base',
    async () => {
      const server = await configureAnalysis();
      stageFile(harness.cwd.path, 'staged.ts', 'const staged = 1;');

      const result = await harness.run('analyze agentic --base missing-ref');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('git diff failed');
      expect(
        server.getRecordedRequests().filter((request) => request.path.endsWith('/analyses')),
      ).toHaveLength(0);
    },
    { timeout: 15000 },
  );
});
