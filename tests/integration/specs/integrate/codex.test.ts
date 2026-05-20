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

// Integration tests for `sonar integrate codex`.
// The codex-prompt-submit hook handler is exhaustively covered by
// hook-agent-prompt-submit.test.ts; this spec only exercises the integrate
// command — script + hooks.json layout, scope semantics, and idempotency.

import { isAbsolute } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { hookScriptName, hookScriptPath, normalizePath, TestHarness } from '../../harness';

const PROMPT_SCRIPT_DIRS = ['.codex', 'hooks', 'sonar-secrets', 'build-scripts'];
const HOOKS_JSON_DIRS = ['.codex', 'hooks.json'];

interface CodexHooksFile {
  hooks?: {
    UserPromptSubmit?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
    }>;
  };
}

describe('integrate codex', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
    const server = await harness.newFakeServer().withAuthToken('tok').start();
    harness.withAuth(server.baseUrl(), 'tok');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe('project-level install (default)', () => {
    it(
      'writes an executable prompt-submit script and a hooks.json entry under .codex/',
      async () => {
        const result = await harness.run('integrate codex');

        expect(result.exitCode).toBe(0);

        const scriptFile = harness.cwd.file(
          ...PROMPT_SCRIPT_DIRS,
          hookScriptName('prompt-secrets'),
        );
        expect(scriptFile.exists()).toBe(true);
        expect(scriptFile.isExecutable).toBe(true);

        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const entry = hooks.hooks?.UserPromptSubmit?.[0];
        expect(entry?.matcher).toBe('*');
        expect(entry?.hooks?.[0]?.type).toBe('command');
        expect(entry?.hooks?.[0]?.command).toContain('sonar-secrets');
      },
      { timeout: 30000 },
    );

    it(
      'uses a project-relative command path so the config is portable',
      async () => {
        await harness.run('integrate codex');

        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const command = hookScriptPath(
          String(hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command),
        );
        expect(isAbsolute(command)).toBe(false);
        expect(command.startsWith('.codex/')).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      're-running does not duplicate the UserPromptSubmit entry',
      async () => {
        await harness.run('integrate codex');
        const result = await harness.run('integrate codex');

        expect(result.exitCode).toBe(0);
        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        expect(hooks.hooks?.UserPromptSubmit).toHaveLength(1);
      },
      { timeout: 30000 },
    );
  });

  describe('global install (-g)', () => {
    it(
      'writes script + hooks.json under $HOME/.codex/ with an absolute command path',
      async () => {
        const result = await harness.run('integrate codex -g');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('.codex')).toBe(false);

        expect(
          harness.userHome.exists(...PROMPT_SCRIPT_DIRS, hookScriptName('prompt-secrets')),
        ).toBe(true);

        const hooks: CodexHooksFile = harness.userHome.file(...HOOKS_JSON_DIRS).asJson();
        const command = hookScriptPath(
          String(hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command),
        );
        expect(isAbsolute(command)).toBe(true);
        expect(command.startsWith(normalizePath(harness.userHome.path))).toBe(true);
      },
      { timeout: 30000 },
    );
  });

  describe('option validation', () => {
    it('rejects --global combined with --project', async () => {
      const result = await harness.run('integrate codex -g -p some-project');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('mutually exclusive');
    });
  });
});
