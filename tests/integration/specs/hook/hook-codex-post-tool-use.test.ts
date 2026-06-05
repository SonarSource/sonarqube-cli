/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Integration tests for `sonar hook codex-post-tool-use`.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { commitFile, initGitRepo } from './git-test-helpers';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const TEST_PROJECT = 'my-project';

describe('sonar hook codex-post-tool-use', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    initGitRepo(harness.cwd.path);
    commitFile(harness.cwd.path, 'README.md', 'baseline');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 and outputs Agentic Analysis JSON when the git change set is clean',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');

      const result = await harness.run(`hook codex-post-tool-use --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(output.hookSpecificOutput.additionalContext).toContain('no issues');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls.length).toBeGreaterThan(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and outputs no hook response when not authenticated',
    async () => {
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');

      const result = await harness.run(`hook codex-post-tool-use --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 with empty stdout when the git change set is empty',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run(`hook codex-post-tool-use --project ${TEST_PROJECT}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );
});
