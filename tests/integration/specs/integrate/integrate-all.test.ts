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

// Integration tests for `sonar integrate` (bare command)

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('integrate (bare command)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
    await harness.newFakeBinariesServer().start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 and reports error when user cancels with q',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run('integrate', { stdinChunks: ['q'] });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No integration selected');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and reports error when user submits empty selection',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      // Enter immediately without toggling any tool
      const result = await harness.run('integrate', { stdinChunks: ['\r'] });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No integration selected');
    },
    { timeout: 15000 },
  );

  it(
    'runs each selected integration to completion',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      // Multiselect: space selects Claude (index 0), five downs reach Git (index 5), space selects it,
      // enter confirms the selection.
      // Claude (--global): no scope prompt. 2 feature prompts: hooks + MCP server.
      // Git (--global): 3 prompts: global warning + pre-commit hook + pre-push hook.
      const result = await harness.run('integrate --global', {
        stdinChunks: [
          // multiselect: toggle Claude, navigate down to Git, toggle Git, confirm
          ' ',
          '\x1b[B',
          '\x1b[B',
          '\x1b[B',
          '\x1b[B',
          '\x1b[B',
          ' ',
          '\r',
          // Claude: Install secret scanning hooks? + Install MCP server?
          '\r',
          '\r',
          // Git: Proceed with global installation? + pre-commit hook + pre-push hook
          '\r',
          '\r',
          '\r',
        ],
        stdinChunkDelayMs: 900,
        timeoutMs: 25000,
      });
      const output = result.stdout + result.stderr;

      expect(result.exitCode).toBe(0);
      // Claude ran
      expect(output).toContain('SonarQube Integration Setup for Claude Code');
      // Git ran
      expect(output).toContain('SonarQube Git Integration (source code scanning)');
      // Both integrations completed successfully
      expect(output.split('Setup complete!').length - 1).toBe(2);
    },
    { timeout: 30000 },
  );
});
