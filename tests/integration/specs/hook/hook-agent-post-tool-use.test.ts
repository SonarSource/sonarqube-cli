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

// Integration tests for `sonar hook claude-post-tool-use`.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { TestHarness } from '../../harness';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const TEST_PROJECT = 'my-project';

function postToolUseStdin(filePath: string, toolName = 'Edit'): string {
  return JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath } });
}

describe('sonar hook claude-post-tool-use', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 and outputs SQAA JSON when analysis returns no issues',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');
      const filePath = join(harness.cwd.path, 'src/main.ts');

      const result = await harness.run(`hook claude-post-tool-use --project ${TEST_PROJECT}`, {
        stdin: postToolUseStdin(filePath),
      });

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(output.hookSpecificOutput.additionalContext).toContain('no issues');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and outputs no hook response when not authenticated',
    async () => {
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');
      const filePath = join(harness.cwd.path, 'src/main.ts');

      const result = await harness.run(`hook claude-post-tool-use --project ${TEST_PROJECT}`, {
        stdin: postToolUseStdin(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    { timeout: 15000 },
  );
});
